// Client-side friend-request flow (FRIENDS.md) through core-net + the real signed
// routes: request → surface → accept → both sides saved locally, plus the
// send_message steer that turns "write a friend-of-friend" into a connect request.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  requestContact,
  acceptRequest,
  declineRequest,
  listRequests,
  drainAccepts,
  sendMessage,
} from "../../src/core-net.ts";
import { generateIdentity } from "../../src/crypto.ts";
import { startMailbox, makeContext, regSelf } from "../helpers.ts";
import type { Mailbox } from "../helpers.ts";
import type { NetContext } from "../../src/core-net.ts";

let mb: Mailbox;
before(async () => {
  mb = await startMailbox();
});
after(() => mb.close());

// A registered user with an empty book, on the shared mailbox.
async function user() {
  const id = generateIdentity();
  const ctx = makeContext(mb.baseUrl, id, []);
  await regSelf(ctx); // claim a handle so requests/accepts can look up keys
  return { id, ctx };
}

// Give ctx a self-name so it rides into requests/accepts as fromName/peer_name.
async function named(name: string) {
  const u = await user();
  u.ctx.me.name = name;
  await u.ctx.client.registerHandle(u.id.signPub.slice(0, 6), name);
  return u;
}

test("request → accept saves both sides and lets them message", async () => {
  const a = await named("Alice");
  const c = await named("Carol");

  assert.deepEqual(await requestContact(a.ctx, { signPub: c.id.signPub }), { ok: true });

  // Carol surfaces the incoming request.
  const carolView = await listRequests(c.ctx);
  assert.equal(carolView.incoming.length, 1);
  assert.equal(carolView.incoming[0]!.signPub, a.id.signPub);
  assert.equal(carolView.incoming[0]!.name, "Alice");

  // Carol accepts → Alice is saved to Carol's book.
  const accepted = await acceptRequest(c.ctx, { signPub: a.id.signPub });
  assert.equal(accepted.ok, true);
  assert.ok(c.ctx.book.contacts.some((x) => x.signPub === a.id.signPub));

  // Alice picks up the accept → Carol saved to Alice's book (she has the boxPub).
  const names = await drainAccepts(a.ctx);
  assert.deepEqual(names, ["Carol"]);
  assert.ok(a.ctx.book.contacts.some((x) => x.signPub === c.id.signPub));

  // Now Alice can message Carol by name.
  const sent = await sendMessage(a.ctx, { to: "Carol", body: "hi!" });
  assert.equal(sent.ok, true);
});

test("listRequests reports accepts even with no pending incoming", async () => {
  const a = await named("Ana");
  const c = await named("Cleo");
  await requestContact(a.ctx, { signPub: c.id.signPub });
  await acceptRequest(c.ctx, { signPub: a.id.signPub });
  const view = await listRequests(a.ctx); // Ana pulls: 0 incoming, 1 accept
  assert.equal(view.incoming.length, 0);
  assert.deepEqual(view.accepted, ["Cleo"]);
});

test("decline drops the request without saving", async () => {
  const a = await named("Amy");
  const c = await named("Cid");
  await requestContact(a.ctx, { signPub: c.id.signPub });
  assert.deepEqual(await declineRequest(c.ctx, { signPub: a.id.signPub }), { ok: true });
  assert.equal((await listRequests(c.ctx)).incoming.length, 0);
  assert.ok(!c.ctx.book.contacts.some((x) => x.signPub === a.id.signPub));
});

test("requestContact reports already_friends after connecting", async () => {
  const a = await named("Abe");
  const c = await named("Cy");
  await requestContact(a.ctx, { signPub: c.id.signPub });
  await acceptRequest(c.ctx, { signPub: a.id.signPub });
  await drainAccepts(a.ctx);
  const again = await requestContact(a.ctx, { signPub: c.id.signPub });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "already_friends");
});

test("requestContact rejects a non-signPub target", async () => {
  const a = await named("Ari");
  const r = await requestContact(a.ctx, { signPub: "not-a-key" });
  assert.equal(r.ok === false && r.reason, "bad_target");
});

test("send_message to a friend-of-friend steers to a connect request", async () => {
  // me ⇄ alice ⇄ carol (all mutual); carol is a friend-of-friend of me, name-only.
  const me = generateIdentity();
  const alice = generateIdentity();
  const carol = generateIdentity();
  const meCtx: NetContext = makeContext(mb.baseUrl, me, [
    { name: "Alice", signPub: alice.signPub, boxPub: alice.boxPub },
  ]);
  const aliceCtx = makeContext(mb.baseUrl, alice, []);
  const carolCtx = makeContext(mb.baseUrl, carol, []);
  await regSelf(meCtx);
  await carolCtx.client.registerHandle(carol.signPub.slice(0, 6), "Carol");
  await meCtx.client.pushEdges([alice.signPub]);
  await aliceCtx.client.pushEdges([me.signPub, carol.signPub]);
  await carolCtx.client.pushEdges([alice.signPub]);

  // "write Carol" — Carol isn't a saved contact, but she's a friend-of-friend.
  const r = await sendMessage(meCtx, { to: "Carol", body: "hey" });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "needs_request");
  if (r.ok === false && r.reason === "needs_request") {
    assert.equal(r.signPub, carol.signPub);
    assert.deepEqual(r.via, ["Alice"]); // mapped to my nickname for the mutual
  }
});
