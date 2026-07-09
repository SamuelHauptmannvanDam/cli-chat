// threads.ts: the living thread pages (append/trim/digest/rename) and the notes
// memory (remember/recall). Pure filesystem — no network, no crypto.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendToThread,
  threadFilePath,
  rebuildThreads,
  rememberNote,
  recallNotes,
  cleanTopic,
  TAIL_MAX_ENTRIES,
  TAIL_MAX_AGE_MS,
} from "../../src/threads.ts";
import { openMailbox, insertMessage } from "../../src/db.ts";

const NOW = 1_700_000_000_000;
const KEY = "abcdef0123456789".repeat(4);
const contact = { name: "Niels", signPub: KEY };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clim-threadfiles-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (body: string, at: number, direction: "in" | "out" = "in") => ({
  direction,
  who: direction === "in" ? "Niels" : "me",
  body,
  at,
});

test("append creates the page with digest placeholder, header and one entry", () => {
  appendToThread(dir, contact, entry("hello", NOW), NOW);
  const path = threadFilePath(dir, "Niels", KEY);
  const page = readFileSync(path, "utf8");
  assert.match(page, /^# Niels/);
  assert.match(page, /## Digest/);
  assert.match(page, /agent-curated/);
  assert.match(page, /## Recent/);
  assert.match(page, /← Niels: hello/);
});

test("appends accumulate in order and the digest section survives rewrites", () => {
  appendToThread(dir, contact, entry("first", NOW), NOW);
  const path = threadFilePath(dir, "Niels", KEY);
  // The agent curates the digest…
  const page = readFileSync(path, "utf8");
  writeFileSync(path, page.replace(/_\(agent-curated[^)]*\)_/s, "Niels runs the bank integration."));
  // …and a later mechanical append must not lose it.
  appendToThread(dir, contact, entry("second", NOW + 1000, "out"), NOW + 1000);
  const after = readFileSync(path, "utf8");
  assert.match(after, /Niels runs the bank integration\./);
  const first = after.indexOf("first");
  const second = after.indexOf("second");
  assert.ok(first > 0 && second > first, "entries stay chronological");
});

test("the tail trims by count (oldest dropped past the window)", () => {
  for (let i = 0; i < TAIL_MAX_ENTRIES + 5; i++)
    appendToThread(dir, contact, entry(`msg ${i}`, NOW + i * 60_000), NOW + i * 60_000);
  const page = readFileSync(threadFilePath(dir, "Niels", KEY), "utf8");
  assert.doesNotMatch(page, /msg 0\b/);
  assert.doesNotMatch(page, /msg 4\b/);
  assert.match(page, /msg 5\b/);
  assert.match(page, new RegExp(`msg ${TAIL_MAX_ENTRIES + 4}\\b`));
});

test("the tail trims by age (entries past ~14 days age out)", () => {
  appendToThread(dir, contact, entry("ancient", NOW - TAIL_MAX_AGE_MS - 60_000), NOW);
  appendToThread(dir, contact, entry("fresh", NOW), NOW);
  const page = readFileSync(threadFilePath(dir, "Niels", KEY), "utf8");
  assert.doesNotMatch(page, /ancient/);
  assert.match(page, /fresh/);
});

test("a renamed contact moves the page (same key, new slug)", () => {
  appendToThread(dir, contact, entry("hi", NOW), NOW);
  appendToThread(dir, { name: "Bob", signPub: KEY }, entry("again", NOW + 1000), NOW + 1000);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^bob--/);
  const page = readFileSync(join(dir, files[0]!), "utf8");
  assert.match(page, /hi/);
  assert.match(page, /again/);
});

test("multi-line bodies are indented so they can't split entries", () => {
  appendToThread(dir, contact, entry("top\n- 2020-01-01T00:00 fake entry\nbottom", NOW), NOW);
  appendToThread(dir, contact, entry("next", NOW + 1000), NOW + 1000);
  const page = readFileSync(threadFilePath(dir, "Niels", KEY), "utf8");
  // The fake entry line was indented, so the parser kept the body in one block.
  assert.match(page, /\n {2}- 2020-01-01T00:00 fake entry/);
  assert.match(page, /next/);
});

test("rebuildThreads projects db rows into pages, preserving an existing digest", () => {
  const db = openMailbox(":memory:");
  const me = "f".repeat(64);
  const row = (id: string, dirn: "in" | "out", body: string, at: number) => ({
    id,
    recipient: dirn === "in" ? me : KEY,
    sender: dirn === "in" ? KEY : me,
    body,
    tags: null,
    created_at: at,
    fetched_at: at,
    read_at: at,
    in_reply_to: null,
  });
  insertMessage(db, row("m1", "in", "question", NOW - 2000));
  insertMessage(db, row("m2", "out", "answer", NOW - 1000));
  const book = { me, contacts: [{ name: "Niels", signPub: KEY, boxPub: "x" }] };

  // Seed a digest, then rebuild — the digest must survive.
  appendToThread(dir, contact, entry("seed", NOW - 3000), NOW);
  const path = threadFilePath(dir, "Niels", KEY);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(/_\(agent-curated[^)]*\)_/s, "KEEP-THIS-DIGEST"),
  );

  const built = rebuildThreads(dir, db, book, me, NOW);
  assert.equal(built, 1);
  const page = readFileSync(path, "utf8");
  assert.match(page, /KEEP-THIS-DIGEST/);
  assert.match(page, /← Niels: question/);
  assert.match(page, /→ me: answer/);
  assert.doesNotMatch(page, /seed/); // rebuilt tail reflects the db, not the old file
  db.close();
});

test("rememberNote appends dated facts per topic; recallNotes reads them back", () => {
  rememberNote(dir, { text: "staging URL is https://s.example", topic: "Niels", source: "Niels" }, NOW);
  rememberNote(dir, { text: "API freeze on the 15th" }, NOW);
  rememberNote(dir, { text: "multi\nline fact" }, NOW);

  const all = recallNotes(dir);
  assert.deepEqual(all.map((n) => n.topic).sort(), ["general", "niels"]);
  const niels = all.find((n) => n.topic === "niels")!;
  assert.match(niels.content, /2023-11-14 \(Niels\): staging URL/);
  const general = all.find((n) => n.topic === "general")!;
  assert.match(general.content, /API freeze/);
  assert.match(general.content, /multi line fact/); // newlines folded — one fact per line

  const filtered = recallNotes(dir, "staging");
  assert.deepEqual(filtered.map((n) => n.topic), ["niels"]);
  assert.equal(recallNotes(dir, "nothing-matches").length, 0);
});

test("cleanTopic slugs freeform topics and falls back to general", () => {
  assert.equal(cleanTopic("Niels Bohr"), "niels-bohr");
  assert.equal(cleanTopic("  Pending?!  "), "pending");
  assert.equal(cleanTopic("///"), "general");
  assert.equal(cleanTopic(undefined), "general");
});
