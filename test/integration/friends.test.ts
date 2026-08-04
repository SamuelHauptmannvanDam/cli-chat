// Friend requests, requests-only mode & handle rotation (FRIENDS.md) end to end
// through the real signed HTTP routes + the mailbox client. Exercises the consent
// handshake (request → accept → both gain the other's keys), the un-messageable
// name-only discovery it protects, and the two handle switches.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMailboxClient } from "../../src/core/mailbox-client.ts";
import { generateIdentity } from "../../src/core/crypto.ts";
import { startMailbox, now, type Mailbox } from "../helpers.ts";

let mb: Mailbox;
before(async () => {
  mb = await startMailbox();
});
after(() => mb.close());

// A registered user on the shared mailbox. Handle is derived from the key so
// concurrent tests in this file never collide on a handle.
async function user(name: string, handle?: string) {
  const id = generateIdentity();
  const client = createMailboxClient(mb.baseUrl, id, now);
  const h = handle ?? id.signPub.slice(0, 6);
  await client.registerHandle(h, name);
  return { id, client, handle: h, name };
}

test("request → accept: both sides gain the other's keys, become confirmed friends", async () => {
  const a = await user("Alice");
  const c = await user("Carol");

  // A discovers C as a name-only node and sends a connect request by signPub.
  const outcome = await a.client.requestContact(c.id.signPub, /* via */ null);
  assert.equal(outcome, "ok");

  // C sees the incoming request, carrying A's keys + self-name.
  const reqs = await c.client.getRequests();
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.fromSignPub, a.id.signPub);
  assert.equal(reqs[0]!.fromName, "Alice");
  assert.equal(reqs[0]!.fromBoxPub, a.id.boxPub);

  // C accepts → gets A's identity to save.
  const saved = await c.client.acceptRequest(a.id.signPub);
  assert.ok(saved);
  assert.equal(saved!.signPub, a.id.signPub);
  assert.equal(saved!.boxPub, a.id.boxPub);
  assert.equal(saved!.name, "Alice");

  // A drains the accept → gains C's boxPub (the send capability granted on accept).
  const accepts = await a.client.takeAccepts();
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0]!.signPub, c.id.signPub);
  assert.equal(accepts[0]!.boxPub, c.id.boxPub);
  assert.equal(accepts[0]!.name, "Carol");

  // The accept-inbox is read-and-clear: draining again yields nothing.
  assert.equal((await a.client.takeAccepts()).length, 0);

  // They're now confirmed (mutual edges), so re-requesting is a no-op.
  assert.equal(await a.client.requestContact(c.id.signPub), "already_friends");
});

test("the request itself carries no send capability until accept", async () => {
  const a = await user("Ann");
  const c = await user("Cy");
  await a.client.requestContact(c.id.signPub);
  // Before C accepts, A has NOTHING owed to them — no boxPub leaks from a pending
  // request. The capability appears only when C accepts (previous test).
  assert.equal((await a.client.takeAccepts()).length, 0);
});

test("decline drops the request with no connection", async () => {
  const a = await user("Ada");
  const c = await user("Cora");
  await a.client.requestContact(c.id.signPub);
  await c.client.declineRequest(a.id.signPub);
  assert.equal((await c.client.getRequests()).length, 0);
  // Declined → not friends, so A can request again later.
  assert.equal(await a.client.requestContact(c.id.signPub), "ok");
});

test("a duplicate pending request is rejected; a self-request is refused", async () => {
  const a = await user("Al");
  const c = await user("Cal");
  assert.equal(await a.client.requestContact(c.id.signPub), "ok");
  assert.equal(await a.client.requestContact(c.id.signPub), "exists");
  assert.equal(await a.client.requestContact(a.id.signPub), "self");
});

test("an unregistered requester cannot send (no handle to seal an accept back to)", async () => {
  const c = await user("Reg");
  const stranger = generateIdentity(); // never registered a handle
  const strangerC = createMailboxClient(mb.baseUrl, stranger, now);
  assert.equal(await strangerC.requestContact(c.id.signPub), "unregistered");
});

test("accepting a request that was never sent returns null", async () => {
  const c = await user("Nope");
  const ghost = generateIdentity();
  assert.equal(await c.client.acceptRequest(ghost.signPub), null);
});

test("requests-only mode kills the resolve path; reversible", async () => {
  const c = await user("Priv", "priv01");
  const a = await user("Seeker");

  // Normally the handle resolves to keys (the out-of-band send path).
  const before = await a.client.resolveHandle("priv01");
  assert.ok(before);
  assert.equal(before!.signPub, c.id.signPub);

  // Requests-only ON → the code no longer resolves (strangers can't seal mail).
  await c.client.setRequestsOnly(true);
  assert.equal(await a.client.resolveHandle("priv01"), null);

  // Reversible: back on and the handle works again.
  await c.client.setRequestsOnly(false);
  assert.ok(await a.client.resolveHandle("priv01"));
});

test("rotate mints a new handle, strands the old one, keeps the same keys", async () => {
  const c = await user("Rot", "old111");
  const a = await user("Peer");

  assert.ok(await a.client.resolveHandle("old111"));

  const res = await c.client.rotateHandle("new222");
  assert.equal(res, "ok");

  // Old code is dead; new code resolves to the SAME identity keys.
  assert.equal(await a.client.resolveHandle("old111"), null);
  const now2 = await a.client.resolveHandle("new222");
  assert.ok(now2);
  assert.equal(now2!.signPub, c.id.signPub);
  assert.equal(now2!.boxPub, c.id.boxPub);
});

test("rotating onto someone else's handle is refused", async () => {
  const owner = await user("Owner", "mine00");
  const other = await user("Other", "other0");
  assert.equal(await other.client.rotateHandle("mine00"), "taken");
  // Owner's handle is untouched.
  assert.ok(await owner.client.resolveHandle("mine00"));
});

test("rotate/requests-only require a signed request", async () => {
  const stale = createMailboxClient(mb.baseUrl, generateIdentity(), () => 0);
  await assert.rejects(() => stale.rotateHandle("zzz999"), /rotate failed: 401/);
  await assert.rejects(() => stale.getRequests(), /requests failed: 401/);
});
