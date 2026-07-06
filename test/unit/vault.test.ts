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
