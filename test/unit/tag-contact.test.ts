import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tagContact, untagContact, type NetContext } from "../../src/core-net.ts";
import { loadContacts, saveContacts, type ContactBook } from "../../src/contacts.ts";

// tagContact/untagContact only touch the book + persist it; the rest of NetContext
// (crypto, network, cache) is irrelevant here, so a partial cast keeps the test focused.
function ctxFor(book: ContactBook, contactsPath: string): NetContext {
  return { book, contactsPath, now: () => 0 } as unknown as NetContext;
}

function freshBook(): ContactBook {
  return {
    me: "me-key",
    contacts: [
      { name: "Niels", signPub: "niels-sign", boxPub: "niels-box" },
      { name: "Sam", signPub: "s1", boxPub: "b1" },
      { name: "Sam", signPub: "s2", boxPub: "b2" },
    ],
  };
}

function withBookOnDisk(fn: (ctx: NetContext, path: string, book: ContactBook) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "clim-tags-"));
  const path = join(dir, "contacts.json");
  const book = freshBook();
  saveContacts(path, book);
  try {
    fn(ctxFor(book, path), path, book);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tagContact adds a tag, persists it, and reports changed", () => {
  withBookOnDisk((ctx, path) => {
    const r = tagContact(ctx, { name: "niels", tag: "Work" });
    assert.equal(r.ok && r.changed, true);
    assert.deepEqual(r.ok && r.tags, ["work"]); // normalised
    // persisted to disk
    assert.deepEqual(loadContacts(path).contacts.find((c) => c.name === "Niels")?.tags, ["work"]);
  });
});

test("tagContact a second time with the same tag is a no-op (changed:false)", () => {
  withBookOnDisk((ctx) => {
    tagContact(ctx, { name: "Niels", tag: "work" });
    const r = tagContact(ctx, { name: "Niels", tag: "WORK" });
    assert.equal(r.ok && r.changed, false);
    assert.deepEqual(r.ok && r.tags, ["work"]);
  });
});

test("untagContact removes a tag and reports changed; removing a missing tag is a no-op", () => {
  withBookOnDisk((ctx, path) => {
    tagContact(ctx, { name: "Niels", tag: "work" });
    const r = untagContact(ctx, { name: "Niels", tag: "work" });
    assert.equal(r.ok && r.changed, true);
    assert.deepEqual(r.ok && r.tags, []);
    assert.equal(loadContacts(path).contacts.find((c) => c.name === "Niels")?.tags, undefined);

    const again = untagContact(ctx, { name: "Niels", tag: "work" });
    assert.equal(again.ok && again.changed, false);
  });
});

test("tagContact records evidence + source into tagMeta and persists it", () => {
  withBookOnDisk((ctx, path) => {
    tagContact(ctx, { name: "Niels", tag: "work", source: "self", evidence: ["standup", "deploy"] });
    const niels = loadContacts(path).contacts.find((c) => c.name === "Niels")!;
    assert.deepEqual(niels.tags, ["work"]);
    assert.equal(niels.tagMeta?.[0]?.source, "self");
    assert.deepEqual(niels.tagMeta?.[0]?.evidence, ["standup", "deploy"]);
  });
});

test("tagContact defaults source to manual and needs no evidence", () => {
  withBookOnDisk((ctx, path) => {
    tagContact(ctx, { name: "Niels", tag: "work" });
    const niels = loadContacts(path).contacts.find((c) => c.name === "Niels")!;
    assert.equal(niels.tagMeta?.[0]?.source, "manual");
    assert.equal(niels.tagMeta?.[0]?.evidence, undefined);
  });
});

test("tagContact accumulates evidence even when the tag already exists (changed:false)", () => {
  withBookOnDisk((ctx, path) => {
    tagContact(ctx, { name: "Niels", tag: "work", source: "self", evidence: ["standup"] });
    const r = tagContact(ctx, { name: "Niels", tag: "work", source: "self", evidence: ["deploy"] });
    assert.equal(r.ok && r.changed, false); // membership unchanged
    const niels = loadContacts(path).contacts.find((c) => c.name === "Niels")!;
    assert.deepEqual(niels.tagMeta?.[0]?.evidence, ["standup", "deploy"]); // but evidence grew + persisted
  });
});

test("untagContact removes the tag and its tagMeta evidence", () => {
  withBookOnDisk((ctx, path) => {
    tagContact(ctx, { name: "Niels", tag: "work", source: "self", evidence: ["standup"] });
    untagContact(ctx, { name: "Niels", tag: "work" });
    const niels = loadContacts(path).contacts.find((c) => c.name === "Niels")!;
    assert.equal(niels.tags, undefined);
    assert.equal(niels.tagMeta, undefined); // evidence cleaned up, not orphaned
  });
});

test("tagContact reports no_contact / ambiguous like send_message, and bad_tag for empty", () => {
  withBookOnDisk((ctx) => {
    const none = tagContact(ctx, { name: "nobody", tag: "work" });
    assert.equal(none.ok, false);
    assert.equal(!none.ok && none.reason, "no_contact");

    const amb = tagContact(ctx, { name: "Sam", tag: "work" });
    assert.equal(amb.ok, false);
    assert.equal(!amb.ok && amb.reason, "ambiguous");
    assert.deepEqual(!amb.ok && amb.candidates, ["Sam", "Sam"]);

    const bad = tagContact(ctx, { name: "Niels", tag: "   " });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.reason, "bad_tag");
  });
});
