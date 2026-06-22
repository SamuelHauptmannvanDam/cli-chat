// Exercises the mailbox HTTP routes directly through Hono's app.fetch — no
// socket needed. Covers the happy paths plus the auth/spoofing rejections that
// are the server's whole job.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../server-mailbox/app.ts";
import { nodeSqliteStore } from "../../server-mailbox/store.ts";
import { makeAuthHeaders } from "../../src/auth.ts";
import { initCrypto, generateIdentity, type Identity } from "../../src/crypto.ts";

const NOW = 1_700_000_000_000;

// Response bodies come back as `unknown`; tests assert on a known shape, so read
// them through this typed helper rather than scattering casts at each call site.
const readJson = async <T>(res: { json(): Promise<unknown> }): Promise<T> => (await res.json()) as T;

before(async () => {
  await initCrypto();
});

function freshApp(
  limits?: { unknownPairHourly?: number; unknownRecipientHourly?: number; unknownSenderDaily?: number },
  rateLimit?: (bucket: "resolve" | "post-ip" | "post-key", key: string) => Promise<boolean>,
) {
  return createApp({ store: nodeSqliteStore(":memory:"), now: () => NOW, limits, rateLimit });
}

// A fake edge limiter that allows the first `allow[bucket]` calls per (bucket,key)
// then denies — stands in for the Cloudflare Rate Limiting binding in tests.
function counterLimiter(allow: Partial<Record<"resolve" | "post-ip" | "post-key", number>>) {
  const seen: Record<string, number> = {};
  return async (bucket: "resolve" | "post-ip" | "post-key", key: string) => {
    const k = `${bucket}:${key}`;
    seen[k] = (seen[k] ?? 0) + 1;
    return seen[k] <= (allow[bucket] ?? Infinity);
  };
}

// Signed request against app.fetch. path is both the URL path and the value
// folded into the canonical signing string, so they always agree.
function signedRequest(
  app: ReturnType<typeof createApp>,
  id: Identity,
  method: string,
  path: string,
  body?: string,
) {
  const payload = body ?? "";
  const headers = makeAuthHeaders(id.signPub, id.signSec, method, path, payload, NOW) as unknown as Record<string, string>;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = body;
    headers["content-type"] = "application/json";
  }
  return app.fetch(new Request(`http://mailbox${path}`, init));
}

// Claim a handle so this identity is a valid recipient (POST /messages now
// rejects mail to never-registered keys).
function register(app: ReturnType<typeof createApp>, id: Identity, handle: string) {
  const body = JSON.stringify({ handle, signPub: id.signPub, boxPub: id.boxPub });
  return signedRequest(app, id, "POST", "/register", body);
}

test("GET /health is open and ok", async () => {
  const res = await freshApp().fetch(new Request("http://mailbox/health"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("unsigned POST /messages is rejected 401", async () => {
  const res = await freshApp().fetch(
    new Request("http://mailbox/messages", { method: "POST", body: "{}" }),
  );
  assert.equal(res.status, 401);
});

test("a signed message can be posted, then drained by its recipient", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const bob = generateIdentity();
  await register(app, bob, "bob123"); // recipient must have a handle on file
  const msg = {
    id: "msg-1",
    recipient: bob.signPub,
    sender: alice.signPub,
    body: "c2VhbGVk",
    tags: null,
    created_at: NOW,
    in_reply_to: null,
  };
  const post = await signedRequest(app, alice, "POST", "/messages", JSON.stringify(msg));
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { ok: true, id: "msg-1" });

  // Bob sees it in his summary...
  const summary = await signedRequest(app, bob, "GET", "/mailbox");
  assert.equal((await readJson<{ count: number }>(summary)).count, 1);

  // ...and drains the blob (still ciphertext — the server never decrypts).
  const drain = await signedRequest(app, bob, "GET", "/messages");
  const { messages } = await readJson<{ messages: { body: string }[] }>(drain);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.body, "c2VhbGVk");
});

test("POST /messages rejects a forged sender (signer ≠ declared sender)", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const mallory = generateIdentity();
  const bob = generateIdentity();
  // Mallory signs but claims the message is from Alice.
  const forged = JSON.stringify({
    id: "forge-1",
    recipient: bob.signPub,
    sender: alice.signPub,
    body: "blob",
    tags: null,
    created_at: NOW,
    in_reply_to: null,
  });
  const res = await signedRequest(app, mallory, "POST", "/messages", forged);
  assert.equal(res.status, 403);
  assert.match((await readJson<{ error: string }>(res)).error, /sender does not match/);
});

test("POST /messages with a signed-but-unparseable body is a 400", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  // Signature is valid over the raw bytes, but the bytes aren't JSON.
  const res = await signedRequest(app, alice, "POST", "/messages", "{not json");
  assert.equal(res.status, 400);
  assert.match((await readJson<{ error: string }>(res)).error, /invalid json/);
});

test("POST /register with a signed-but-unparseable body is a 400", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const res = await signedRequest(app, alice, "POST", "/register", "{nope");
  assert.equal(res.status, 400);
});

test("POST /messages with missing fields is a 400", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const body = JSON.stringify({ id: "x", sender: alice.signPub }); // no recipient/body
  const res = await signedRequest(app, alice, "POST", "/messages", body);
  assert.equal(res.status, 400);
});

test("POST /messages to a never-registered recipient is a 404", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const stranger = generateIdentity(); // no handle claimed
  const msg = JSON.stringify({
    id: "m-404",
    recipient: stranger.signPub,
    sender: alice.signPub,
    body: "c2VhbGVk",
    tags: null,
    created_at: NOW,
    in_reply_to: null,
  });
  const res = await signedRequest(app, alice, "POST", "/messages", msg);
  assert.equal(res.status, 404);
  assert.match((await readJson<{ error: string }>(res)).error, /unknown recipient/);
});

test("POST /messages with an oversize body is rejected 413", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const bob = generateIdentity();
  await register(app, bob, "bob413");
  const msg = JSON.stringify({
    id: "m-big",
    recipient: bob.signPub,
    sender: alice.signPub,
    body: "A".repeat(17 * 1024), // over MAX_BODY_BYTES (16 KB)
    tags: null,
    created_at: NOW,
    in_reply_to: null,
  });
  const res = await signedRequest(app, alice, "POST", "/messages", msg);
  assert.equal(res.status, 413);
  assert.match((await readJson<{ error: string }>(res)).error, /too large/);
});

// A sealed-ish message blob from `from` to `to`, signed by `from`.
function msgFrom(from: Identity, to: Identity, id: string) {
  return JSON.stringify({
    id,
    recipient: to.signPub,
    sender: from.signPub,
    body: "c2VhbGVk",
    tags: null,
    created_at: NOW,
    in_reply_to: null,
  });
}

test("an unknown sender is throttled past the per-pair hourly cap", async () => {
  const app = freshApp({ unknownPairHourly: 2 });
  const alice = generateIdentity();
  const bob = generateIdentity();
  await register(app, bob, "bobcap");
  const send = (n: number) => signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, `m-${n}`));
  assert.equal((await send(1)).status, 200);
  assert.equal((await send(2)).status, 200);
  const blocked = await send(3); // Alice is unknown to Bob and over the cap
  assert.equal(blocked.status, 429);
  assert.match((await readJson<{ error: string }>(blocked)).error, /rate limited/);
});

test("a sender the recipient wrote to first is exempt from throttling", async () => {
  const app = freshApp({ unknownPairHourly: 1 });
  const alice = generateIdentity();
  const bob = generateIdentity();
  await register(app, alice, "alicex"); // Alice must be a valid recipient too
  await register(app, bob, "bobxxx");
  // Bob writes to Alice first → Alice becomes "known" to Bob.
  assert.equal((await signedRequest(app, bob, "POST", "/messages", msgFrom(bob, alice, "b-0"))).status, 200);
  // Now Alice can write to Bob past the (cap=1) unknown limit — she's known.
  assert.equal((await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "a-1"))).status, 200);
  assert.equal((await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "a-2"))).status, 200);
  assert.equal((await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "a-3"))).status, 200);
});

test("the per-recipient backstop caps a Sybil spray from many fresh keys", async () => {
  const app = freshApp({ unknownPairHourly: 5, unknownRecipientHourly: 2 });
  const bob = generateIdentity();
  await register(app, bob, "bobsyb");
  // Each message comes from a brand-new key, so the per-pair cap never trips —
  // only the per-recipient unknown backstop can stop this.
  const spray = (n: number) => {
    const stranger = generateIdentity();
    return signedRequest(app, stranger, "POST", "/messages", msgFrom(stranger, bob, `s-${n}`));
  };
  assert.equal((await spray(1)).status, 200);
  assert.equal((await spray(2)).status, 200);
  assert.equal((await spray(3)).status, 429); // 3rd distinct stranger this hour
});

test("a single key's cold outreach is capped per day across recipients", async () => {
  const app = freshApp({ unknownPairHourly: 5, unknownRecipientHourly: 50, unknownSenderDaily: 2 });
  const spammer = generateIdentity();
  const r1 = generateIdentity(), r2 = generateIdentity(), r3 = generateIdentity();
  await register(app, r1, "rrr111");
  await register(app, r2, "rrr222");
  await register(app, r3, "rrr333");
  // Three different new people, one message each: per-pair (5) and per-recipient
  // (50) caps never bite, so only the daily cold-reach cap (2) can stop the 3rd.
  assert.equal((await signedRequest(app, spammer, "POST", "/messages", msgFrom(spammer, r1, "c-1"))).status, 200);
  assert.equal((await signedRequest(app, spammer, "POST", "/messages", msgFrom(spammer, r2, "c-2"))).status, 200);
  const blocked = await signedRequest(app, spammer, "POST", "/messages", msgFrom(spammer, r3, "c-3"));
  assert.equal(blocked.status, 429);
  assert.match((await readJson<{ error: string }>(blocked)).error, /new people/);
});

test("/resolve is rate-limited per the edge limiter, before the lookup", async () => {
  const app = freshApp(undefined, counterLimiter({ resolve: 2 }));
  const alice = generateIdentity();
  await register(app, alice, "alice1");
  // First two resolves pass (limiter allows 2); the lookup itself still works.
  assert.equal((await signedRequest(app, alice, "GET", "/resolve/alice1")).status, 200);
  assert.equal((await signedRequest(app, alice, "GET", "/resolve/alice1")).status, 200);
  // Third is throttled — even though the handle exists, the limiter gates first
  // (before signature verification), so it's 429 regardless of the valid auth.
  const blocked = await signedRequest(app, alice, "GET", "/resolve/alice1");
  assert.equal(blocked.status, 429);
});

test("unsigned /resolve is rejected 401 — the directory can't be walked anonymously", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  await register(app, alice, "alice1");
  const res = await app.fetch(new Request("http://mailbox/resolve/alice1"));
  assert.equal(res.status, 401);
});

test("POST /messages is rate-limited at the IP layer before auth", async () => {
  const app = freshApp(undefined, counterLimiter({ "post-ip": 1 }));
  const alice = generateIdentity();
  const bob = generateIdentity();
  await register(app, bob, "bobip1");
  assert.equal((await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "i-1"))).status, 200);
  // Second POST from the same IP (all test requests share the "local" key) → 429,
  // regardless of validity.
  const blocked = await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "i-2"));
  assert.equal(blocked.status, 429);
});

test("POST /messages is rate-limited per sender key after auth", async () => {
  const app = freshApp(undefined, counterLimiter({ "post-key": 2 }));
  const alice = generateIdentity();
  const bob = generateIdentity();
  await register(app, bob, "bobkey");
  assert.equal((await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "k-1"))).status, 200);
  assert.equal((await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "k-2"))).status, 200);
  const blocked = await signedRequest(app, alice, "POST", "/messages", msgFrom(alice, bob, "k-3"));
  assert.equal(blocked.status, 429);
});

test("register then resolve a handle round-trips public keys", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const body = JSON.stringify({ handle: "alice1", signPub: alice.signPub, boxPub: alice.boxPub });
  const reg = await signedRequest(app, alice, "POST", "/register", body);
  assert.deepEqual(await reg.json(), { ok: true, handle: "alice1" });

  // /resolve requires a signed request (only real accounts resolve); the keys it
  // returns are public, but this keeps the directory from being walked anonymously.
  const res = await signedRequest(app, alice, "GET", "/resolve/alice1");
  assert.deepEqual(await res.json(), { signPub: alice.signPub, boxPub: alice.boxPub });
});

test("register rejects claiming a handle for someone else's key", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const bob = generateIdentity();
  const body = JSON.stringify({ handle: "evil12", signPub: bob.signPub, boxPub: bob.boxPub });
  const res = await signedRequest(app, alice, "POST", "/register", body); // alice signs, claims bob's key
  assert.equal(res.status, 403);
});

test("register rejects a malformed handle", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const body = JSON.stringify({ handle: "too-long!", signPub: alice.signPub, boxPub: alice.boxPub });
  const res = await signedRequest(app, alice, "POST", "/register", body);
  assert.equal(res.status, 400);
});

test("resolve of an unknown handle is 404", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const res = await signedRequest(app, alice, "GET", "/resolve/nobody");
  assert.equal(res.status, 404);
});
