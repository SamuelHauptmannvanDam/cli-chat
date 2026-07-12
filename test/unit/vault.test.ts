// Unit tests for the vault assemble/apply/merge helpers (AUTH-SYNC.md). These are
// the client-side glue that turns on-disk account state into the synced blob and
// back. assemble/apply touch the filesystem, so each test points MESSENGER_HOME
// at a fresh temp dir; merge is pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts reads MESSENGER_HOME fresh on each call, so set it before importing.
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "clim-vault-"));
  const prev = process.env.MESSENGER_HOME;
  process.env.MESSENGER_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.MESSENGER_HOME;
    else process.env.MESSENGER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

const { assembleVault, applyVault, mergeVaults } = await import("../../src/vault.ts");

function seedUser(home: string, handle: string, identity: object, contacts: object, settings: object) {
  const dir = join(home, "users", handle);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), JSON.stringify(identity));
  writeFileSync(join(dir, "contacts.json"), JSON.stringify(contacts));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
}

test("assemble then apply round-trips identity, contacts and settings", () => {
  withHome((home) => {
    const identity = { handle: "AbC123", signPub: "ff", boxPub: "ee", signSec: "dd", boxSec: "cc", name: "Sam" };
    const contacts = { me: "ff", contacts: [{ name: "Niels", signPub: "11", boxPub: "22", tags: ["work"] }] };
    const settings = { tagMode: "auto" };
    seedUser(home, "AbC123", identity, contacts, settings);

    const blob = assembleVault("AbC123");

    // Materialise into a clean home and confirm every file came back intact.
    rmSync(join(home, "users", "AbC123"), { recursive: true, force: true });
    const handle = applyVault(blob);
    assert.equal(handle, "AbC123");

    const id = JSON.parse(readFileSync(join(home, "users", "AbC123", "identity.json"), "utf8"));
    assert.equal(id.signSec, "dd", "private keys are escrowed in the vault");
    const cb = JSON.parse(readFileSync(join(home, "users", "AbC123", "contacts.json"), "utf8"));
    assert.deepEqual(cb.contacts[0].tags, ["work"]);
    const st = JSON.parse(readFileSync(join(home, "users", "AbC123", "settings.json"), "utf8"));
    assert.equal(st.tagMode, "auto");
  });
});

test("applyVault refuses a blob with no handle", () => {
  withHome(() => {
    const blob = JSON.stringify({ v: 1, identity: {}, contacts: null, settings: null });
    assert.throws(() => applyVault(blob), /no handle/);
  });
});

test("context files (threads + notes) ride the vault and come back on apply", () => {
  withHome((home) => {
    const identity = { handle: "AbC123", signPub: "ff", boxPub: "ee", name: "Sam" };
    seedUser(home, "AbC123", identity, { me: "ff", contacts: [] }, { tagMode: "auto" });
    const ctx = join(home, "users", "AbC123", "context");
    mkdirSync(join(ctx, "threads"), { recursive: true });
    mkdirSync(join(ctx, "notes"), { recursive: true });
    writeFileSync(join(ctx, "threads", "niels.md"), "# Niels\n\nDigest: bankdata.\n");
    writeFileSync(join(ctx, "notes", "disclosure.md"), "- weekends shareable with work\n");
    writeFileSync(join(ctx, "notes", "not-md.txt"), "ignored");

    const blob = assembleVault("AbC123");
    const parsed = JSON.parse(blob);
    assert.deepEqual(Object.keys(parsed.files).sort(), [
      "context/notes/disclosure.md",
      "context/threads/niels.md",
    ]);

    rmSync(join(home, "users", "AbC123"), { recursive: true, force: true });
    applyVault(blob);
    assert.equal(
      readFileSync(join(ctx, "threads", "niels.md"), "utf8"),
      "# Niels\n\nDigest: bankdata.\n",
    );
    assert.equal(
      readFileSync(join(ctx, "notes", "disclosure.md"), "utf8"),
      "- weekends shareable with work\n",
    );
  });
});

test("applyVault ignores file entries outside the context dirs (no path escape)", () => {
  withHome((home) => {
    const blob = JSON.stringify({
      v: 1,
      identity: { handle: "AbC123" },
      contacts: null,
      settings: null,
      files: {
        "context/threads/../../../evil.md": "nope",
        "somewhere/else.md": "nope",
        "context/notes/ok.md": "kept",
      },
    });
    applyVault(blob);
    const notes = join(home, "users", "AbC123", "context", "notes");
    assert.equal(readFileSync(join(notes, "ok.md"), "utf8"), "kept");
    // The traversal entry lands (if anywhere) under the notes/threads dir by
    // basename only — never outside the user tree.
    assert.throws(() => readFileSync(join(home, "evil.md"), "utf8"));
  });
});

test("mergeVaults unions context files, local wins per path", () => {
  const local = JSON.stringify({
    v: 1,
    identity: { handle: "AbC123" },
    contacts: { me: "ff", contacts: [] },
    settings: null,
    files: { "context/notes/a.md": "local a", "context/notes/b.md": "local b" },
  });
  const server = JSON.stringify({
    v: 1,
    identity: { handle: "AbC123" },
    contacts: { me: "ff", contacts: [] },
    settings: null,
    files: { "context/notes/b.md": "server b", "context/notes/c.md": "server c" },
  });
  const merged = JSON.parse(mergeVaults(local, server));
  assert.deepEqual(merged.files, {
    "context/notes/a.md": "local a",
    "context/notes/b.md": "local b",
    "context/notes/c.md": "server c",
  });
});

test("mergeVaults unions contacts and their tags, last-write-wins per person", () => {
  const local = JSON.stringify({
    v: 1,
    identity: { handle: "AbC123" },
    contacts: {
      me: "ff",
      contacts: [
        { name: "Niels", signPub: "11", tags: ["work"] }, // edited locally
        { name: "Mette", signPub: "33", tags: ["family"] }, // only local
      ],
    },
    settings: { tagMode: "auto" },
  });
  const server = JSON.stringify({
    v: 1,
    identity: { handle: "AbC123" },
    contacts: {
      me: "ff",
      contacts: [
        { name: "Niels Bohr", signPub: "11", tags: ["gaming"] }, // server's view of Niels
        { name: "Tobias", signPub: "44", tags: ["work"] }, // only server
      ],
    },
    settings: { tagMode: "auto" },
  });

  const merged = JSON.parse(mergeVaults(local, server));
  const byKey = Object.fromEntries(merged.contacts.contacts.map((c: any) => [c.signPub, c]));

  // All three distinct people survive the union.
  assert.deepEqual(Object.keys(byKey).sort(), ["11", "33", "44"]);
  // Local wins on overlapping fields (name), tags are unioned across both.
  assert.equal(byKey["11"].name, "Niels");
  assert.deepEqual(byKey["11"].tags.sort(), ["gaming", "work"]);
  // The local-only and server-only contacts are both kept.
  assert.deepEqual(byKey["33"].tags, ["family"]);
  assert.deepEqual(byKey["44"].tags, ["work"]);
});
