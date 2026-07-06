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

// me → alice → carol. carol is registered (reachable) with a self-name.
async function scenario() {
  const me = generateIdentity();
  const alice = generateIdentity();
  const carol = generateIdentity();
  const meC = createMailboxClient(mb.baseUrl, me, now);
  const aliceC = createMailboxClient(mb.baseUrl, alice, now);
  const carolC = createMailboxClient(mb.baseUrl, carol, now);
  await carolC.registerHandle(carol.signPub.slice(0, 6), "Carol C");
  await meC.pushEdges([alice.signPub]); // alice is my contact
  await aliceC.pushEdges([carol.signPub]); // carol is alice's contact
  return { me, alice, carol, meC, aliceC, carolC };
}

test("getNetwork returns a contact-of-contact with name + via", async () => {
  const { alice, carol, meC } = await scenario();
  const net = await meC.getNetwork();
  assert.equal(net.length, 1);
  const p = net[0]!;
  assert.equal(p.signPub, carol.signPub);
  assert.equal(p.name, "Carol C"); // their OWN self-name
  assert.equal(p.mutuals, 1);
  assert.deepEqual(p.via, [alice.signPub]); // my contact who links to them
  assert.ok(p.boxPub && p.handle); // reachable → writeable
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
