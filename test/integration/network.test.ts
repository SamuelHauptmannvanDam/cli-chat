// Contacts of contacts (CONTACTS-OF-CONTACTS.md) end to end through the real
// signed HTTP routes + the client: push edges, pull your second-degree network,
// remove an edge, and the quiet opt-out. Runs the same signing path the MCP
// server uses, against the in-process mailbox — no Cloudflare needed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMailboxClient } from "../../src/mailbox-client.ts";
import { generateIdentity } from "../../src/crypto.ts";
import { startMailbox, now, type Mailbox } from "../helpers.ts";

let mb: Mailbox;
before(async () => {
  mb = await startMailbox();
});
after(() => mb.close());

// me ⇄ alice ⇄ carol, all mutual — contacts-of-contacts now traverses CONFIRMED
// (two-way) friendships only (FRIENDS.md §4a), so every edge is reciprocated.
// carol is registered (reachable) with a self-name.
async function scenario() {
  const me = generateIdentity();
  const alice = generateIdentity();
  const carol = generateIdentity();
  const meC = createMailboxClient(mb.baseUrl, me, now);
  const aliceC = createMailboxClient(mb.baseUrl, alice, now);
  const carolC = createMailboxClient(mb.baseUrl, carol, now);
  await carolC.registerHandle(carol.signPub.slice(0, 6), "Carol C");
  await meC.pushEdges([alice.signPub]); // me → alice
  await aliceC.pushEdges([me.signPub, carol.signPub]); // alice → me, alice → carol
  await carolC.pushEdges([alice.signPub]); // carol → alice
  return { me, alice, carol, meC, aliceC, carolC };
}

test("getNetwork returns a contact-of-contact with name + via (no send key)", async () => {
  const { alice, carol, meC } = await scenario();
  const net = await meC.getNetwork();
  assert.equal(net.length, 1);
  const p = net[0]!;
  assert.equal(p.signPub, carol.signPub);
  assert.equal(p.name, "Carol C"); // their OWN self-name
  assert.equal(p.mutuals, 1);
  assert.deepEqual(p.via, [alice.signPub]); // my contact who links to them
  // Discovery is NAME-ONLY: no boxPub/handle, so a friend-of-friend can't be
  // sealed mail directly — you reach them via a connect request (FRIENDS.md §1).
  assert.equal((p as unknown as Record<string, unknown>).boxPub, undefined);
  assert.equal((p as unknown as Record<string, unknown>).handle, undefined);
});

test("a one-way (non-mutual) edge does NOT propagate into the network", async () => {
  const me = generateIdentity();
  const alice = generateIdentity();
  const carol = generateIdentity();
  const meC = createMailboxClient(mb.baseUrl, me, now);
  const aliceC = createMailboxClient(mb.baseUrl, alice, now);
  const carolC = createMailboxClient(mb.baseUrl, carol, now);
  await carolC.registerHandle(carol.signPub.slice(0, 6), "Carol C");
  // me ⇄ alice is mutual, but alice → carol is one-way (carol never saved alice).
  await meC.pushEdges([alice.signPub]);
  await aliceC.pushEdges([me.signPub, carol.signPub]);
  const net = await meC.getNetwork();
  assert.equal(net.length, 0, "a one-way save must not leak someone into the graph");
});

test("a second-degree person you already have is excluded", async () => {
  const { carol, meC } = await scenario();
  await meC.pushEdges([carol.signPub]); // now carol is MY contact too
  const net = await meC.getNetwork();
  assert.equal(net.length, 0, "already-a-contact is not a contact-of-contact");
});

test("removeEdge drops the reach through that contact", async () => {
  const { alice, meC } = await scenario();
  assert.equal((await meC.getNetwork()).length, 1);
  await meC.removeEdge(alice.signPub);
  assert.equal((await meC.getNetwork()).length, 0);
});

test("the quiet opt-out hides someone from everyone's network", async () => {
  const { carol, carolC, meC } = await scenario();
  assert.equal((await meC.getNetwork()).length, 1);
  await carolC.hideFromNetwork(); // carol opts out via her own signed request
  assert.equal((await meC.getNetwork()).length, 0);
  assert.ok(carol.signPub);
});

test("network requires a signed request", async () => {
  const stale = createMailboxClient(mb.baseUrl, generateIdentity(), () => 0);
  await assert.rejects(() => stale.getNetwork(), /network failed: 401/);
});
