// The signing HTTP client against the real in-process mailbox: the summary
// endpoint (which core-net never calls) and the error path that surfaces a
// failed request as a thrown Error.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMailboxClient } from "../../src/core/mailbox-client.ts";
import { generateIdentity } from "../../src/core/crypto.ts";
import { startMailbox, twoUsers, now, type Mailbox } from "../helpers.ts";
import { sendMessage } from "../../src/core-net.ts";

let mb: Mailbox;
before(async () => {
  mb = await startMailbox();
});
after(() => mb.close());

test("summary() reports waiting mail count and metadata", async () => {
  const { a: alice, bId } = await twoUsers(mb.baseUrl);
  await sendMessage(alice, { to: "Bob", body: "ping" });

  const bobClient = createMailboxClient(mb.baseUrl, bId, now);
  const summary = await bobClient.summary();
  assert.equal(summary.count, 1);
  assert.equal(summary.messages[0].sender, alice.me.signPub);
});

test("a request the server rejects throws with status detail", async () => {
  // A client whose clock is at the epoch signs a stale request → server 401s →
  // the client surfaces it as a thrown Error rather than failing silently.
  const stale = createMailboxClient(mb.baseUrl, generateIdentity(), () => 0);
  await assert.rejects(() => stale.summary(), /summary failed: 401/);
});

test("resolveHandle returns null for an unknown handle", async () => {
  const client = createMailboxClient(mb.baseUrl, generateIdentity(), now);
  assert.equal(await client.resolveHandle("nobody"), null);
});
