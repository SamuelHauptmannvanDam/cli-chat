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
  loadContacts,
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
