// HISTORY.md: outbound persistence + the history query, over the real mailbox.
// Covers the plan's test list: outbound rows born read (never surface as inbox
// mail), thread merge in order across both directions, partial/ambiguous names,
// the q filter, read_at untouched by recall, and the thread files (tail append
// on send/drain + rebuild from the db).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMailbox, twoUsers, now, FIXED_NOW, type Mailbox } from "../helpers.ts";
import {
  sendMessage,
  messageHistory,
  messagesAvailable,
  takeUnread,
  sync,
} from "../../src/core-net.ts";
import { unreadFor } from "../../src/db.ts";
import { rebuildThreads } from "../../src/threads.ts";

let mb: Mailbox;

before(async () => {
  mb = await startMailbox();
});

after(() => mb.close());

test("outbound rows persist locally, born read — never surface as inbox mail", async () => {
  const { a, aId } = await twoUsers(mb.baseUrl);
  const r = await sendMessage(a, { to: "Bob", body: "hello there" });
  assert.equal(r.ok, true);
  // The sender's own cache holds the sent half…
  const h = await messageHistory(a, {});
  assert.equal(h.ok, true);
  assert.equal(h.ok && h.messages.length, 1);
  assert.equal(h.ok && h.messages[0]!.direction, "out");
  assert.equal(h.ok && h.messages[0]!.who, "me");
  // …but nothing is unread for the sender: the row was born read.
  assert.equal(unreadFor(a.cache, aId.signPub).length, 0);
  const avail = await messagesAvailable(a);
  assert.equal(avail.count, 0);
});

test("history merges both directions in chronological order", async () => {
  const { a, b } = await twoUsers(mb.baseUrl);
  // Distinct created_at per message — the shared fixed clock would tie them all.
  let t = FIXED_NOW;
  a.now = () => ++t;
  b.now = () => ++t;
  await sendMessage(a, { to: "Bob", body: "one" });
  await sync(b);
  const inbox = takeUnread(b);
  await sendMessage(b, { in_reply_to: inbox[0]!.id, body: "two" });
  await sendMessage(a, { to: "Bob", body: "three" });

  const h = await messageHistory(a, { with: "Bob" });
  assert.equal(h.ok, true);
  if (!h.ok) return;
  assert.deepEqual(
    h.messages.map((m) => [m.direction, m.body]),
    [
      ["out", "one"],
      ["in", "two"],
      ["out", "three"],
    ],
  );
  assert.equal(h.with, "Bob");
  // The reply threads back to the original.
  assert.equal(h.messages[1]!.in_reply_to, h.messages[0]!.id);
});

test("history resolves partial names and reports ambiguous with candidates", async () => {
  const { a, b } = await twoUsers(mb.baseUrl, "Alice", "Niels - bankdata");
  await sendMessage(a, { to: "Niels - bankdata", body: "ping" });
  const h = await messageHistory(a, { with: "niels" });
  assert.equal(h.ok, true);

  // A second contact containing the query makes it ambiguous.
  a.book.contacts.push({ name: "Niels Bohr", signPub: "f".repeat(64), boxPub: b.me.boxPub });
  const amb = await messageHistory(a, { with: "niels" });
  assert.equal(amb.ok, false);
  assert.equal(!amb.ok && amb.reason, "ambiguous");
  assert.deepEqual(!amb.ok && amb.candidates, ["Niels - bankdata", "Niels Bohr"]);

  const none = await messageHistory(a, { with: "zelda" });
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.reason, "no_contact");
});

test("the q filter narrows by body substring (LIKE-escaped)", async () => {
  const { a } = await twoUsers(mb.baseUrl);
  await sendMessage(a, { to: "Bob", body: "the endpoint is /v2/users" });
  await sendMessage(a, { to: "Bob", body: "lunch tomorrow?" });
  await sendMessage(a, { to: "Bob", body: "100% done" });

  const h = await messageHistory(a, { with: "Bob", q: "endpoint" });
  assert.equal(h.ok && h.messages.length, 1);
  assert.match(h.ok ? h.messages[0]!.body : "", /endpoint/);

  // A literal % must not become match-everything.
  const pct = await messageHistory(a, { with: "Bob", q: "100%" });
  assert.equal(pct.ok && pct.messages.length, 1);
  const pctAll = await messageHistory(a, { with: "Bob", q: "%" });
  assert.equal(pctAll.ok && pctAll.messages.length, 1);
});

test("recall never marks mail read — unread still surfaces after a history pull", async () => {
  const { a, b } = await twoUsers(mb.baseUrl);
  await sendMessage(a, { to: "Bob", body: "still unread after recall" });
  const h = await messageHistory(b, { with: "Alice" }); // syncs + reads history
  assert.equal(h.ok && h.messages.length, 1);
  // The message is IN the slice and STILL unread for the normal inbox paths.
  const avail = await messagesAvailable(b);
  assert.equal(avail.count, 1);
});

test("limit keeps the newest slice; before pages further back", async () => {
  const { a } = await twoUsers(mb.baseUrl);
  // Distinct created_at per message (the fixed clock would tie them).
  let t = FIXED_NOW;
  a.now = () => ++t;
  for (let i = 1; i <= 5; i++) await sendMessage(a, { to: "Bob", body: `msg ${i}` });
  const last2 = await messageHistory(a, { with: "Bob", limit: 2 });
  assert.deepEqual(last2.ok && last2.messages.map((m) => m.body), ["msg 4", "msg 5"]);
  const paged = await messageHistory(a, {
    with: "Bob",
    limit: 2,
    before: last2.ok ? last2.messages[0]!.at : 0,
  });
  assert.deepEqual(paged.ok && paged.messages.map((m) => m.body), ["msg 2", "msg 3"]);
});

test("thread files: send + drain append to the contact's living page", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "clim-threads-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "clim-threads-b-"));
  try {
    const { a, b } = await twoUsers(mb.baseUrl);
    a.threadsPath = dirA;
    b.threadsPath = dirB;
    await sendMessage(a, { to: "Bob", body: "first line\nsecond line" });
    await sync(b);

    const aFiles = readdirSync(dirA);
    assert.equal(aFiles.length, 1);
    assert.match(aFiles[0]!, /^bob--[0-9a-f]{8}\.md$/);
    const aPage = readFileSync(join(dirA, aFiles[0]!), "utf8");
    assert.match(aPage, /## Digest/);
    assert.match(aPage, /## Recent/);
    assert.match(aPage, /→ me: first line/);
    assert.match(aPage, /\n {2}second line/); // continuation lines indented

    const bFiles = readdirSync(dirB);
    assert.equal(bFiles.length, 1);
    const bPage = readFileSync(join(dirB, bFiles[0]!), "utf8");
    assert.match(bPage, /← Alice: first line/);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("rebuildThreads regenerates pages from the db (upgrade backfill)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clim-rebuild-"));
  try {
    const { a, b } = await twoUsers(mb.baseUrl);
    await sendMessage(a, { to: "Bob", body: "kept in the db" });
    await sync(b);
    // No threadsPath was set → no files exist. Rebuild projects the db out.
    const builtA = rebuildThreads(dir, a.cache, a.book, a.me.signPub, now());
    assert.equal(builtA, 1);
    const page = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    assert.match(page, /→ me: kept in the db/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
