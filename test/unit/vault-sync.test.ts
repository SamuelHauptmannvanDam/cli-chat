// Unit tests for syncVault's reconciliation logic (AUTH-SYNC.md), in particular
// the "reidentified" path: a device whose local signPub lost the one-time
// first-push race for an account must adopt the account's real identity
// instead of hammering the server with a doomed push under the wrong key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountClient } from "../../src/core/account-client.ts";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "clim-vault-sync-"));
  const prev = process.env.MESSENGER_HOME;
  process.env.MESSENGER_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.MESSENGER_HOME;
    else process.env.MESSENGER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

const { syncVault } = await import("../../src/vault-sync.ts");

function seedUser(home: string, handle: string, identity: object) {
  const dir = join(home, "users", handle);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), JSON.stringify(identity));
  writeFileSync(join(dir, "contacts.json"), JSON.stringify({ me: (identity as any).signPub, contacts: [] }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ tagMode: "auto" }));
}

function fakeClient(overrides: Partial<AccountClient>): AccountClient {
  return {
    startLogin: async () => {
      throw new Error("not implemented");
    },
    poll: async () => {
      throw new Error("not implemented");
    },
    pullVault: async () => ({ blob: null, version: 0 }),
    pushVault: async () => {
      throw new Error("pushVault should not be called once a mismatch is detected");
    },
    checkout: async () => "unauthorized",
    fetchDataKey: async () => "unauthorized",
    pushHistory: async () => "unauthorized",
    pullHistory: async () => ({ chunks: [], last: 0 }),
    logout: async () => {},
    ...overrides,
  };
}

test("syncVault adopts the account's real identity instead of pushing under a losing signPub", async () => {
  await withHome(async (home) => {
    // This device lost the first-push race: its local identity (losingHandle /
    // losingSignPub) is NOT what the account ended up bound to.
    seedUser(home, "Losing1", { handle: "Losing1", signPub: "losing-pub", boxPub: "lb", signSec: "ls", boxSec: "lbs" });

    const winningBlob = JSON.stringify({
      v: 1,
      identity: { handle: "Winner1", signPub: "winning-pub", boxPub: "wb", signSec: "ws", boxSec: "wbs" },
      contacts: { me: "winning-pub", contacts: [] },
      settings: { tagMode: "auto" },
    });

    const client = fakeClient({
      pullVault: async () => ({ blob: winningBlob, version: 5 }),
    });

    const outcome = await syncVault(client, "tok", "Losing1", "losing-pub", 0, true);
    assert.deepEqual(outcome, { action: "reidentified", handle: "Winner1", version: 5 });

    // The winning identity was materialised locally so the caller can switch
    // its session over to it.
    const id = JSON.parse(readFileSync(join(home, "users", "Winner1", "identity.json"), "utf8"));
    assert.equal(id.signPub, "winning-pub");
  });
});

test("syncVault pushes normally when the local identity matches the server's", async () => {
  await withHome(async (home) => {
    seedUser(home, "AbC123", { handle: "AbC123", signPub: "same-pub", boxPub: "b", signSec: "s", boxSec: "bs" });

    const serverBlob = JSON.stringify({
      v: 1,
      identity: { handle: "AbC123", signPub: "same-pub" },
      contacts: { me: "same-pub", contacts: [] },
      settings: { tagMode: "auto" },
    });

    let pushed = false;
    const client = fakeClient({
      pullVault: async () => ({ blob: serverBlob, version: 3 }),
      pushVault: async (_token, _blob, version) => {
        pushed = true;
        return { ok: true, version };
      },
    });

    const outcome = await syncVault(client, "tok", "AbC123", "same-pub", 3, true);
    assert.ok(pushed, "push should proceed once identity matches");
    assert.equal(outcome.action, "pushed");
  });
});
