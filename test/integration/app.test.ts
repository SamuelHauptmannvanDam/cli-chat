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

before(async () => {
  await initCrypto();
});

function freshApp(limits?: { unknownPairHourly?: number; unknownRecipientHourly?: number }) {
  return createApp({ store: nodeSqliteStore(":memory:"), now: () => NOW, limits });
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
  assert.equal((await summary.json()).count, 1);

  // ...and drains the blob (still ciphertext — the server never decrypts).
  const drain = await signedRequest(app, bob, "GET", "/messages");
  const { messages } = await drain.json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "c2VhbGVk");
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
  assert.match((await res.json()).error, /sender does not match/);
});

test("POST /messages with a signed-but-unparseable body is a 400", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  // Signature is valid over the raw bytes, but the bytes aren't JSON.
  const res = await signedRequest(app, alice, "POST", "/messages", "{not json");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid json/);
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
  assert.match((await res.json()).error, /unknown recipient/);
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
  assert.match((await res.json()).error, /too large/);
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
  assert.match((await blocked.json()).error, /rate limited/);
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

test("register then resolve a handle round-trips public keys", async () => {
  const app = freshApp();
  const alice = generateIdentity();
  const body = JSON.stringify({ handle: "alice1", signPub: alice.signPub, boxPub: alice.boxPub });
  const reg = await signedRequest(app, alice, "POST", "/register", body);
  assert.deepEqual(await reg.json(), { ok: true, handle: "alice1" });

  // /resolve is public (these are public keys) — no signature needed.
  const res = await app.fetch(new Request("http://mailbox/resolve/alice1"));
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
  const res = await freshApp().fetch(new Request("http://mailbox/resolve/nobody"));
  assert.equal(res.status, 404);
});
