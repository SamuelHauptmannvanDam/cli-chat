import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolve,
  displayNameByKey,
  senderLabel,
  contactByKey,
  removeContactByKey,
  loadContacts,
  orderedContacts,
  cleanName,
  cleanTag,
  addTag,
  removeTag,
  NAME_MAX,
  TAG_MAX,
  type Contact,
  type ContactBook,
} from "../../src/contacts.ts";

const book: ContactBook = {
  me: "me-key",
  contacts: [
    { name: "Niels", signPub: "niels-sign", boxPub: "niels-box" },
    { name: "Sam", aliases: ["Sammy", "Samuel"], signPub: "sam-sign", boxPub: "sam-box" },
    { name: "Sam", signPub: "sam2-sign", boxPub: "sam2-box" },
  ],
};

test("resolve matches an exact name, case-insensitively", () => {
  const r = resolve(book, "niels");
  assert.equal(r.status, "resolved");
  assert.equal(r.status === "resolved" && r.contact.signPub, "niels-sign");
});

test("resolve matches an alias", () => {
  const r = resolve(book, "samuel");
  assert.equal(r.status, "resolved");
  assert.equal(r.status === "resolved" && r.contact.signPub, "sam-sign");
});

test("resolve reports none for an unknown name", () => {
  const r = resolve(book, "nobody");
  assert.equal(r.status, "none");
  assert.equal(r.status === "none" && r.query, "nobody");
});

test("resolve reports ambiguous when two contacts share a name", () => {
  const r = resolve(book, "sam");
  assert.equal(r.status, "ambiguous");
  assert.equal(r.status === "ambiguous" && r.candidates.length, 2);
});

test("resolve falls back to a substring match when nothing matches exactly", () => {
  const longBook: ContactBook = {
    me: "me-key",
    contacts: [{ name: "Niels - bankdata", signPub: "niels-sign", boxPub: "niels-box" }],
  };
  const r = resolve(longBook, "niels");
  assert.equal(r.status, "resolved");
  assert.equal(r.status === "resolved" && r.contact.signPub, "niels-sign");
});

test("resolve prefers an exact match over a substring match", () => {
  const mixedBook: ContactBook = {
    me: "me-key",
    contacts: [
      { name: "Sam", signPub: "sam-sign", boxPub: "sam-box" },
      { name: "Sammy from work", signPub: "sammy-sign", boxPub: "sammy-box" },
    ],
  };
  const r = resolve(mixedBook, "sam");
  assert.equal(r.status, "resolved");
  assert.equal(r.status === "resolved" && r.contact.signPub, "sam-sign");
});

test("resolve reports ambiguous when a substring matches several contacts", () => {
  const dupeBook: ContactBook = {
    me: "me-key",
    contacts: [
      { name: "Niels - bankdata", signPub: "n1-sign", boxPub: "n1-box" },
      { name: "Niels Bohr", signPub: "n2-sign", boxPub: "n2-box" },
    ],
  };
  const r = resolve(dupeBook, "niels");
  assert.equal(r.status, "ambiguous");
  assert.equal(r.status === "ambiguous" && r.candidates.length, 2);
});

test("resolve reports none for an empty query rather than matching everyone", () => {
  const r = resolve(book, "   ");
  assert.equal(r.status, "none");
});

test("displayNameByKey maps a signPub, falling back to a short prefix", () => {
  assert.equal(displayNameByKey(book, "sam-sign"), "Sam");
  assert.equal(displayNameByKey(book, "abcdef0123456789"), "abcdef01…");
});

test("senderLabel: nick wins, auto-saved shows name+handle, unknown shows prefix", () => {
  const labelBook: ContactBook = {
    me: "me-key",
    contacts: [
      // A nick the user chose — shown plain, never their self-name or handle.
      { name: "Boss", signPub: "alice-sign", boxPub: "a-box", handle: "alice1" },
      // Auto-saved from a self-introduction — shown as "name (handle)".
      { name: "Mallory", signPub: "mal-sign", boxPub: "m-box", handle: "mal007", auto: true },
      // Auto-saved but no handle known — falls back to just the name.
      { name: "Pat", signPub: "pat-sign", boxPub: "p-box", auto: true },
    ],
  };
  assert.equal(senderLabel(labelBook, "alice-sign"), "Boss");
  assert.equal(senderLabel(labelBook, "mal-sign"), "Mallory (mal007)");
  assert.equal(senderLabel(labelBook, "pat-sign"), "Pat");
  assert.equal(senderLabel(labelBook, "abcdef0123456789"), "abcdef01…");
});

test("contactByKey finds the contact for a signPub, else undefined", () => {
  assert.equal(contactByKey(book, "niels-sign")?.name, "Niels");
  assert.equal(contactByKey(book, "unknown"), undefined);
});

test("removeContactByKey drops only the matching key and reports success", () => {
  const b: ContactBook = {
    me: "me-key",
    contacts: [
      { name: "Niels", signPub: "niels-sign", boxPub: "niels-box" },
      { name: "Sam", signPub: "sam-sign", boxPub: "sam-box" },
    ],
  };
  assert.equal(removeContactByKey(b, "niels-sign"), true);
  assert.equal(b.contacts.length, 1);
  assert.equal(b.contacts[0]?.signPub, "sam-sign");
});

test("removeContactByKey returns false when no contact has that key", () => {
  const b: ContactBook = {
    me: "me-key",
    contacts: [{ name: "Sam", signPub: "sam-sign", boxPub: "sam-box" }],
  };
  assert.equal(removeContactByKey(b, "nobody"), false);
  assert.equal(b.contacts.length, 1);
});

test("loadContacts parses a valid book from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "clim-contacts-"));
  const path = join(dir, "contacts.json");
  writeFileSync(path, JSON.stringify(book));
  try {
    assert.deepEqual(loadContacts(path), book);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadContacts rejects a structurally invalid book", () => {
  const dir = mkdtempSync(join(tmpdir(), "clim-contacts-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, JSON.stringify({ contacts: [] })); // missing `me`
  try {
    assert.throws(() => loadContacts(path), /Invalid contact book/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = 1_000_000_000_000; // fixed "now" for deterministic window tests
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => NOW - d * DAY;

// Build a book of N contacts named A, B, C… Each entry in `wrote` gives a contact
// a send count and a "last written N days ago" timestamp, marking them active.
const mkContacts = (n: number, wrote: Record<string, { sent: number; days: number }> = {}): Contact[] =>
  Array.from({ length: n }, (_, i) => {
    const name = String.fromCharCode(65 + i); // A, B, C…
    const c: Contact = { name, signPub: `${name}-sign`, boxPub: `${name}-box` };
    const w = wrote[name];
    if (w) {
      c.sentCount = w.sent;
      c.lastMessageAt = daysAgo(w.days);
    }
    return c;
  });

test("orderedContacts: active list is who you've written most in the last 60 days", () => {
  const { active, rest } = orderedContacts(
    mkContacts(5, {
      D: { sent: 30, days: 1 },
      B: { sent: 20, days: 5 },
      E: { sent: 10, days: 10 },
    }),
    NOW,
  );
  assert.deepEqual(active.map((c) => c.name), ["D", "B", "E"]); // most-written first
  assert.deepEqual(rest.map((c) => c.name), ["A", "C"]); // never written → alphabetical
});

test("orderedContacts: a contact written >60 days ago ages out into the rest", () => {
  const { active, rest } = orderedContacts(
    mkContacts(3, {
      A: { sent: 99, days: 90 }, // heavily written but long quiet → drops off
      B: { sent: 2, days: 3 }, // recent → active
    }),
    NOW,
  );
  assert.deepEqual(active.map((c) => c.name), ["B"]);
  assert.deepEqual(rest.map((c) => c.name), ["A", "C"]); // A rejoins, alphabetical
});

test("orderedContacts: a contact exactly at the 60-day edge still counts as active", () => {
  const { active } = orderedContacts(mkContacts(1, { A: { sent: 1, days: 60 } }), NOW);
  assert.deepEqual(active.map((c) => c.name), ["A"]);
});

test("orderedContacts: equal counts within active broken by recency, then name", () => {
  const { active } = orderedContacts(
    mkContacts(3, {
      A: { sent: 5, days: 4 },
      B: { sent: 5, days: 2 }, // same count, more recent → above A
      C: { sent: 5, days: 4 }, // same count + same recency as A → after A by name
    }),
    NOW,
  );
  assert.deepEqual(active.map((c) => c.name), ["B", "A", "C"]);
});

test("orderedContacts: does not mutate the input array", () => {
  const contacts = mkContacts(3, { C: { sent: 9, days: 1 } });
  orderedContacts(contacts, NOW);
  assert.deepEqual(contacts.map((c) => c.name), ["A", "B", "C"]); // original order untouched
});

test("cleanName trims, drops empties, and caps at NAME_MAX", () => {
  assert.equal(cleanName("  Niels Bohr  "), "Niels Bohr");
  assert.equal(cleanName(""), "");
  assert.equal(cleanName(undefined), "");
  assert.equal(cleanName(null), "");
  assert.equal(cleanName("x".repeat(NAME_MAX + 50)).length, NAME_MAX);
});

test("cleanName strips control characters and newlines (untrusted self-names)", () => {
  assert.equal(cleanName("Niels\nBohr"), "Niels Bohr"); // newline → single space
  assert.equal(cleanName("a\t\tb"), "a b"); // run of control chars → one space
});

test("cleanTag lower-cases, collapses whitespace, trims, and caps at TAG_MAX", () => {
  assert.equal(cleanTag("  Work  "), "work");
  assert.equal(cleanTag("Close   Friends"), "close friends"); // run of spaces → one
  assert.equal(cleanTag("Co\nWorker"), "co worker"); // control char → space
  assert.equal(cleanTag(""), "");
  assert.equal(cleanTag(undefined), "");
  assert.equal(cleanTag("x".repeat(TAG_MAX + 20)).length, TAG_MAX);
});

test("addTag adds a normalised tag and dedupes case-insensitively", () => {
  const c: Contact = { name: "Niels", signPub: "n", boxPub: "b" };
  assert.equal(addTag(c, "Work"), true);
  assert.deepEqual(c.tags, ["work"]);
  assert.equal(addTag(c, "work"), false); // already present (after normalising)
  assert.equal(addTag(c, "WORK"), false);
  assert.deepEqual(c.tags, ["work"]);
  assert.equal(addTag(c, "  "), false); // empty tag → no-op
});

test("removeTag removes case-insensitively and drops the array when empty", () => {
  const c: Contact = { name: "Niels", signPub: "n", boxPub: "b", tags: ["work", "gaming"] };
  assert.equal(removeTag(c, "WORK"), true);
  assert.deepEqual(c.tags, ["gaming"]);
  assert.equal(removeTag(c, "missing"), false); // not present → no-op
  assert.equal(removeTag(c, "gaming"), true);
  assert.equal(c.tags, undefined); // last tag gone → no empty array left behind
});
