// The rewritten account layer (AUTH-SYNC.md) end to end through the real Hono
// app + node store + the real client modules: the per-account data key, the
// signPub bind-once guard (the anti-hijack rule), the encrypted history stream,
// session revocation (logout), and the client-side syncHistory round-trip that
// converges two devices on one history. Email runs in dev mode (exposeMagicLink)
// like auth.test.ts.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../../server-mailbox/app.ts";
import { nodeSqliteStore, type Store } from "../../server-mailbox/store.ts";
import { serveFetch, type ServedFetch } from "../serve-fetch.ts";
import { createAccountClient, type AccountClient } from "../../src/account-client.ts";
import { encryptBlob, decryptBlob } from "../../src/blob-crypto.ts";
import { initCrypto } from "../../src/crypto.ts";

const NOW = 1_700_000_000_000;

before(async () => {
  await initCrypto();
});

async function boot(
  extra?: Partial<AppDeps>,
): Promise<{ store: Store; srv: ServedFetch; client: AccountClient }> {
  const store = nodeSqliteStore(":memory:");
  const app = createApp({
    store,
    now: () => NOW,
    exposeMagicLink: true,
    // The current deploy shape: paywall off, everything works right after login.
    freeSync: true,
    ...extra,
  });
  const srv = await serveFetch(app.fetch);
  return { store, srv, client: createAccountClient(srv.url) };
}

// Drive a full login and return the session + the account payload (incl. dataKey).
async function login(client: AccountClient, email: string) {
  const start = await client.startLogin(email);
  await fetch(start.devLink!);
  const ready = await client.poll(start.poll_id);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("unreachable");
  return { token: ready.session_token, account: ready.account };
}

test("login delivers a stable per-account data key", async () => {
  const { srv, client } = await boot();
  try {
    const first = await login(client, "sam@example.com");
    assert.ok(first.account.dataKey, "poll ready carries the data key");
    assert.equal(first.account.dataKey!.length, 64, "32 bytes of hex");

    // A second login (another device) gets the SAME key — it's per-account.
    const second = await login(client, "sam@example.com");
    assert.equal(second.account.dataKey, first.account.dataKey);

    // The upgrade route hands it to an already-authenticated session too.
    assert.equal(await client.fetchDataKey(first.token), first.account.dataKey);
  } finally {
    srv.close();
  }
});

test("an account's signPub binds once — a different identity's push is refused", async () => {
  const { srv, client } = await boot();
  try {
    const { token } = await login(client, "sam@example.com");
    const original = "a".repeat(64);
    const hijacker = "b".repeat(64);

    const first = await client.pushVault(token, JSON.stringify({ n: 1 }), 1, original);
    assert.deepEqual(first, { ok: true, version: 1 });

    // The hijack case from the old flow: a device with a DIFFERENT identity
    // pushing into this account must be rejected, not rebound.
    await assert.rejects(
      () => client.pushVault(token, JSON.stringify({ n: 2 }), 2, hijacker),
      /403/,
    );

    // The vault is untouched and the binding unchanged.
    const pulled = await client.pullVault(token);
    assert.deepEqual(pulled, { blob: JSON.stringify({ n: 1 }), version: 1 });
  } finally {
    srv.close();
  }
});

test("history: encrypted chunks append with seqs, pull is a cursor, other devices are woken", async () => {
  const woken: string[] = [];
  const { srv, client } = await boot({ notifyHistory: (s) => woken.push(s) });
  try {
    const { token, account } = await login(client, "sam@example.com");
    const key = account.dataKey!;
    const signPub = "c".repeat(64);
    await client.pushVault(token, JSON.stringify({ v: 1 }), 1, signPub); // binds signPub

    const chunk = (rows: object[]) => encryptBlob(JSON.stringify({ v: 1, rows }), key);
    const one = await client.pushHistory(token, [chunk([{ id: "m1" }]), chunk([{ id: "m2" }])]);
    assert.deepEqual(one, { last: 2 });
    assert.deepEqual(woken, [signPub], "history push wakes the account's devices");

    const two = await client.pushHistory(token, [chunk([{ id: "m3" }])]);
    assert.deepEqual(two, { last: 3 });

    // Cursor semantics: since=1 returns seqs 2..3 only, and `last` says when to stop.
    const page = await client.pullHistory(token, 1);
    assert.equal(page === "unauthorized" || page === "payment_required", false);
    if (typeof page === "string") throw new Error("unreachable");
    assert.deepEqual(page.chunks.map((c) => c.seq), [2, 3]);
    assert.equal(page.last, 3);
    const rows = JSON.parse(decryptBlob(page.chunks[0]!.blob, key)).rows;
    assert.deepEqual(rows, [{ id: "m2" }]);

    // Both non-empty pushes fanned out; an empty push never does.
    await client.pushHistory(token, []);
    assert.deepEqual(woken, [signPub, signPub]);
  } finally {
    srv.close();
  }
});

test("history is gated like the vault when the paywall is on", async () => {
  const { srv, client } = await boot({ freeSync: false, checkoutUrl: "https://pay.example/x" });
  try {
    const { token } = await login(client, "sam@example.com");
    assert.equal(await client.pushHistory(token, ["blob"]), "payment_required");
    assert.equal(await client.pullHistory(token, 0), "payment_required");
  } finally {
    srv.close();
  }
});

test("logout revokes the session server-side", async () => {
  const { srv, client } = await boot();
  try {
    const { token } = await login(client, "sam@example.com");
    assert.notEqual(await client.pullVault(token), "unauthorized");
    await client.logout(token);
    assert.equal(await client.pullVault(token), "unauthorized", "token is dead after logout");
    await client.logout(token); // idempotent — a dead token logs out fine
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// Client-side syncHistory: two devices of one account converge on one history.
// ---------------------------------------------------------------------------

test("syncHistory pushes one device's cache and lands it on the other, born read", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "clim-hist-"));
  const prevHome = process.env.MESSENGER_HOME;
  process.env.MESSENGER_HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.MESSENGER_HOME;
    else process.env.MESSENGER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // Import AFTER MESSENGER_HOME points at the temp dir (paths read it per call,
  // but keeping the discipline of vault.test.ts here).
  const { openMailbox, insertMessage, historyFor, getMessage } = await import("../../src/db.ts");
  const { saveSession } = await import("../../src/session.ts");
  const { syncHistory } = await import("../../src/history-sync.ts");
  const { inboxFile } = await import("../../src/paths.ts");

  const { srv, client } = await boot();
  try {
    const { token, account } = await login(client, "sam@example.com");
    const key = account.dataKey!;
    const me = "d".repeat(64);

    // Device A: a local cache with one received and one sent message.
    mkdirSync(join(home, "users", "devA"), { recursive: true });
    mkdirSync(join(home, "users", "devB"), { recursive: true });
    saveSession("devA", token, "sam@example.com", NOW, key);
    saveSession("devB", token, "sam@example.com", NOW, key);
    const cacheA = openMailbox(inboxFile("devA"));
    const cacheB = openMailbox(inboxFile("devB"));
    insertMessage(cacheA, {
      id: "in-1", recipient: me, sender: "niels", body: "deploy landed",
      tags: null, created_at: NOW - 1000, fetched_at: NOW, read_at: null,
      in_reply_to: null, answered_by: null,
    });
    insertMessage(cacheA, {
      id: "out-1", recipient: "niels", sender: me, body: "nice, shipping the docs",
      tags: null, created_at: NOW - 500, fetched_at: NOW - 500, read_at: NOW - 500,
      in_reply_to: "in-1", answered_by: null,
    });

    // A pushes (first sync also seeds the outbox from the whole cache).
    const a = await syncHistory(client, token, "devA", key, cacheA, me);
    assert.deepEqual(a, { ok: true, pushed: 2, pulled: 2, cursor: 1 });

    // B pulls and now answers "what did niels say" identically.
    const b = await syncHistory(client, token, "devB", key, cacheB, me);
    assert.equal(b.ok, true);
    const thread = historyFor(cacheB, me, "niels");
    assert.deepEqual(thread.map((r) => r.id), ["in-1", "out-1"]);
    assert.equal(thread[0]!.body, "deploy landed");

    // Born read: synced history must never surface as new mail on B — even a
    // message that was still unread on A.
    assert.ok(getMessage(cacheB, "in-1")!.read_at != null);

    // Converged: another round-trip on both sides moves nothing.
    assert.deepEqual(await syncHistory(client, token, "devA", key, cacheA, me), {
      ok: true, pushed: 0, pulled: 0, cursor: 1,
    });
    assert.deepEqual(await syncHistory(client, token, "devB", key, cacheB, me), {
      ok: true, pushed: 0, pulled: 0, cursor: 1,
    });
    cacheA.close();
    cacheB.close();
  } finally {
    srv.close();
  }
});
