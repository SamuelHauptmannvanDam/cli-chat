import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolve,
  displayName,
  displayNameByKey,
  contactByKey,
  loadContacts,
  type ContactBook,
} from "../../src/contacts.ts";

const book: ContactBook = {
  me: "me-key",
  contacts: [
    { id: "niels", name: "Niels", signPub: "niels-sign", boxPub: "niels-box" },
    { id: "sam", name: "Sam", aliases: ["Sammy", "Samuel"], signPub: "sam-sign", boxPub: "sam-box" },
    { id: "sam2", name: "Sam", signPub: "sam2-sign", boxPub: "sam2-box" },
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
  assert.equal(r.status === "resolved" && r.contact.id, "sam");
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

test("displayName reverse-maps an id, falling back to the raw id", () => {
  assert.equal(displayName(book, "niels"), "Niels");
  assert.equal(displayName(book, "ghost"), "ghost");
});

test("displayNameByKey maps a signPub, falling back to a short prefix", () => {
  assert.equal(displayNameByKey(book, "sam-sign"), "Sam");
  assert.equal(displayNameByKey(book, "abcdef0123456789"), "abcdef01…");
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
