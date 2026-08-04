// Exercises the account layer (AUTH-SYNC.md) end to end through the real Hono
// app + node store + the client the MCP server uses: magic-link login, the paid
// gate on the vault, push/pull, and last-write-wins conflict. Email is run in dev
// mode (exposeMagicLink), so the "click" is just fetching the returned devLink —
// no real mailbox needed.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppDeps } from "../../server-mailbox/app.ts";
import { nodeSqliteStore, type Store } from "../../server-mailbox/store.ts";
import { serveFetch, type ServedFetch } from "../serve-fetch.ts";
import { createAccountClient, type AccountClient } from "../../src/core/account-client.ts";
import { initCrypto } from "../../src/core/crypto.ts";

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
    exposeMagicLink: true, // dev: /auth/login returns devLink instead of emailing
    checkoutUrl: "https://pay.example/unlock",
    ...extra,
  });
  const srv = await serveFetch(app.fetch);
  return { store, srv, client: createAccountClient(srv.url) };
}

// Drive a full login: start → click the dev link → poll ready → session token.
async function login(client: AccountClient, email: string): Promise<string> {
  const start = await client.startLogin(email);
  assert.ok(start.poll_id);
  assert.ok(start.devLink, "dev mode should return the magic link");

  const pending = await client.poll(start.poll_id);
  assert.equal(pending.status, "pending");

  const clicked = await fetch(start.devLink!);
  assert.equal(clicked.status, 200);

  const ready = await client.poll(start.poll_id);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("unreachable");
  assert.equal(ready.account.email, email);
  return ready.session_token;
}

test("magic-link login mints a session", async () => {
  const { srv, client } = await boot();
  try {
    const token = await login(client, "sam@example.com");
    assert.ok(token.length >= 32);
  } finally {
    srv.close();
  }
});

test("the magic link is single-use", async () => {
  const { srv, client } = await boot();
  try {
    const start = await client.startLogin("sam@example.com");
    const first = await fetch(start.devLink!);
    assert.equal(first.status, 200);
    const second = await fetch(start.devLink!);
    assert.equal(second.status, 400, "a used link can't be replayed");
  } finally {
    srv.close();
  }
});

test("expired poll id reports expired, not ready", async () => {
  const { srv, client } = await boot();
  try {
    const res = await client.poll("does-not-exist");
    assert.equal(res.status, "expired");
  } finally {
    srv.close();
  }
});

test("vault is gated behind payment, then push/pull round-trips", async () => {
  const { store, srv, client } = await boot();
  try {
    const token = await login(client, "sam@example.com");
    const signPub = "a".repeat(64);

    // Unpaid → 402 on both read and write.
    assert.equal(await client.pullVault(token), "payment_required");
    const blocked = await client.pushVault(token, JSON.stringify({ v: 1 }), 1, signPub);
    assert.equal(blocked.ok, false);
    if (blocked.ok === false) assert.equal(blocked.reason, "payment_required");

    // Flip the paid flag the way the Stripe webhook would.
    const account = await store.getOrCreateAccount("sam@example.com", NOW);
    await store.setAccountPaid(account.id, NOW);

    // Empty to start.
    const empty = await client.pullVault(token);
    assert.deepEqual(empty, { blob: null, version: 0 });

    // First push binds signPub and stores v1.
    const pushed = await client.pushVault(token, JSON.stringify({ contacts: ["a"] }), 1, signPub);
    assert.deepEqual(pushed, { ok: true, version: 1 });

    const pulled = await client.pullVault(token);
    assert.deepEqual(pulled, { blob: JSON.stringify({ contacts: ["a"] }), version: 1 });

    // signPub got bound to the account.
    const bound = await store.getOrCreateAccount("sam@example.com", NOW);
    assert.equal(bound.signPub, signPub);
  } finally {
    srv.close();
  }
});

test("a successful vault push wakes the account's devices (notifyVault), a stale one doesn't", async () => {
  const woken: string[] = [];
  const { store, srv, client } = await boot({ notifyVault: (signPub) => woken.push(signPub) });
  try {
    const token = await login(client, "sam@example.com");
    const signPub = "b".repeat(64);
    const account = await store.getOrCreateAccount("sam@example.com", NOW);
    await store.setAccountPaid(account.id, NOW);

    // A successful push wakes the account's signPub (real-time fan-out to devices).
    const ok = await client.pushVault(token, JSON.stringify({ contacts: ["a"] }), 1, signPub);
    assert.deepEqual(ok, { ok: true, version: 1 });
    assert.deepEqual(woken, [signPub], "one wake, keyed by the account signPub");

    // A stale push (same version) is a no-op → NO extra wake.
    const stale = await client.pushVault(token, JSON.stringify({ contacts: ["b"] }), 1, signPub);
    assert.equal(stale.ok, false);
    assert.deepEqual(woken, [signPub], "stale push must not fan out");
  } finally {
    srv.close();
  }
});

test("a stale push is rejected with the current row to merge", async () => {
  const { store, srv, client } = await boot();
  try {
    const token = await login(client, "sam@example.com");
    const signPub = "b".repeat(64);
    const account = await store.getOrCreateAccount("sam@example.com", NOW);
    await store.setAccountPaid(account.id, NOW);

    await client.pushVault(token, JSON.stringify({ n: 1 }), 1, signPub);
    // Pushing at a version not greater than the stored one is stale.
    const stale = await client.pushVault(token, JSON.stringify({ n: 2 }), 1, signPub);
    assert.equal(stale.ok, false);
    if (stale.ok === false && stale.reason === "stale") {
      assert.equal(stale.current.version, 1);
      assert.equal(stale.current.blob, JSON.stringify({ n: 1 }));
    } else {
      assert.fail("expected a stale conflict");
    }

    // Retrying at version+1 succeeds.
    const ok = await client.pushVault(token, JSON.stringify({ n: 2 }), 2, signPub);
    assert.deepEqual(ok, { ok: true, version: 2 });
  } finally {
    srv.close();
  }
});

test("unknown bearer token is unauthorized", async () => {
  const { srv, client } = await boot();
  try {
    assert.equal(await client.pullVault("not-a-real-token"), "unauthorized");
  } finally {
    srv.close();
  }
});
