import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestTagsFor,
  CROSS_SUGGEST_THRESHOLD,
  type ContactBook,
} from "../../src/contacts.ts";
import { suggestTags, declineTagContact, tagContact, type NetContext } from "../../src/core-net.ts";
import { loadContacts, saveContacts } from "../../src/contacts.ts";

// A book where Niels is firmly `work` (evidence: standup/sprint/deploy), and Tobias is
// untagged. Mette is `family`. Used to check Tobias gets matched to work, not family.
function clusterBook(): ContactBook {
  return {
    me: "me",
    contacts: [
      {
        name: "Niels", signPub: "niels", boxPub: "nb", tags: ["work"],
        tagMeta: [{ tag: "work", source: "self", evidence: ["standup", "sprint", "deploy"], addedAt: 1 }],
      },
      {
        name: "Mette", signPub: "mette", boxPub: "mb", tags: ["family"],
        tagMeta: [{ tag: "family", source: "self", evidence: ["dinner", "birthday", "weekend"], addedAt: 1 }],
      },
      { name: "Tobias", signPub: "tobias", boxPub: "tb" },
    ],
  };
}

const tobias = (b: ContactBook) => b.contacts.find((c) => c.name === "Tobias")!;

test("suggestTagsFor matches a shared-topic cluster above the threshold", () => {
  const b = clusterBook();
  const s = suggestTagsFor(b, tobias(b), ["standup", "sprint", "deploy"]);
  assert.equal(s.length, 1);
  assert.equal(s[0]?.tag, "work");
  assert.ok((s[0]?.score ?? 0) >= CROSS_SUGGEST_THRESHOLD);
});

test("suggestTagsFor weighs a mentioned mutual contact's NAME higher than a topic", () => {
  const b = clusterBook();
  // mentioning Niels (a work contact) + one work topic → name(2) + topic(1) = 3 ≥ threshold
  const s = suggestTagsFor(b, tobias(b), ["Niels", "standup"]);
  assert.equal(s[0]?.tag, "work");
  assert.ok(s[0]?.shared.includes("niels"));
});

test("suggestTagsFor returns nothing below the confidence bar", () => {
  const b = clusterBook();
  const s = suggestTagsFor(b, tobias(b), ["standup"]); // one topic = 1 < 3
  assert.deepEqual(s, []);
});

test("suggestTagsFor excludes tags the contact already has or has declined", () => {
  const b = clusterBook();
  const t = tobias(b);
  t.tags = ["work"]; // already work
  assert.deepEqual(suggestTagsFor(b, t, ["standup", "sprint", "deploy"]), []);
  t.tags = undefined;
  t.declinedTags = ["work"]; // declined
  assert.deepEqual(suggestTagsFor(b, t, ["standup", "sprint", "deploy"]), []);
});

test("suggestTagsFor doesn't confuse circles — family signals suggest family, not work", () => {
  const b = clusterBook();
  const s = suggestTagsFor(b, tobias(b), ["dinner", "birthday", "weekend"]);
  assert.equal(s[0]?.tag, "family");
  assert.equal(s.find((x) => x.tag === "work"), undefined);
});

// ---- ctx-level ops ----

function ctxFor(book: ContactBook, contactsPath: string): NetContext {
  return { book, contactsPath, now: () => 0 } as unknown as NetContext;
}

function withBook(fn: (ctx: NetContext, path: string, book: ContactBook) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "clim-cross-"));
  const path = join(dir, "contacts.json");
  const book = clusterBook();
  saveContacts(path, book);
  try {
    fn(ctxFor(book, path), path, book);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("suggestTags resolves a name and returns scored suggestions", () => {
  withBook((ctx) => {
    const r = suggestTags(ctx, { name: "Tobias", signals: ["standup", "sprint", "deploy"] });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.suggestions[0]?.tag, "work");
  });
});

test("declineTagContact removes the tag (if present) and blocks future suggestions", () => {
  withBook((ctx, path) => {
    // auto cross-tag Tobias work, then decline it
    tagContact(ctx, { name: "Tobias", tag: "work", source: "cross", evidence: ["standup"] });
    const r = declineTagContact(ctx, { name: "Tobias", tag: "work" });
    assert.equal(r.ok && r.declined, true);
    assert.equal(r.ok && r.removed, true);
    const saved = loadContacts(path).contacts.find((c) => c.name === "Tobias")!;
    assert.equal(saved.tags, undefined); // removed
    assert.deepEqual(saved.declinedTags, ["work"]); // remembered
    // and now a strong match no longer suggests it
    assert.deepEqual(suggestTags(ctx, { name: "Tobias", signals: ["standup", "sprint", "deploy"] }), {
      ok: true, name: "Tobias", suggestions: [],
    });
  });
});

test("declineTagContact on an unapplied tag just records the decline", () => {
  withBook((ctx) => {
    const r = declineTagContact(ctx, { name: "Tobias", tag: "work" });
    assert.equal(r.ok && r.removed, false);
    assert.equal(r.ok && r.declined, true);
  });
});
