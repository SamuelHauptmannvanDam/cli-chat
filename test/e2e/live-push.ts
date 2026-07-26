// Live end-to-end against the DEPLOYED worker. Covers both questions:
//   1. send/receive — Sam → Niels, plus a reply back
//   2. push delivery — Niels runs the warmer (the real WebSocket path); Sam
//      sends; assert the message arrives via a wake within a few seconds (the
//      fallback poll is 60s, so a fast arrival proves push, not polling).
//
// Self-contained: it mints two throwaway identities via the registry, so it does
// touch the live mailbox/registry (two new handles + a couple of test messages
// in throwaway inboxes). Run:  node test/e2e/live-push.ts
//   (override the target with MESSENGER_MAILBOX_URL=http://localhost:8787)

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCrypto, generateIdentity, type Identity } from "../../src/crypto.ts";
import { createMailboxClient } from "../../src/mailbox-client.ts";
import { randomHandle } from "../../src/key-code.ts";
import { openMailbox, unreadFor, markRead, type Mailbox } from "../../src/db.ts";
import { sendMessage, sync, type NetContext } from "../../src/core-net.ts";
import { startWarmer } from "../../src/warmer.ts";
import { resolveMailboxUrl } from "../../src/config.ts";

const URL = resolveMailboxUrl();
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await initCrypto();
console.log(`mailbox: ${URL}`);

// Claim a free handle so the recipient is "registered" (mailbox rejects mail to
// unregistered keys). Mutates id.handle.
async function claim(id: Identity): Promise<void> {
  const client = createMailboxClient(URL, id, now);
  for (let i = 0; i < 8; i++) {
    const h = randomHandle(randomBytes(8));
    if ((await client.registerHandle(h)) === "ok") {
      id.handle = h;
      return;
    }
  }
  throw new Error("couldn't claim a handle");
}

const sam = generateIdentity();
sam.name = "SamTest";
const niels = generateIdentity();
niels.name = "NielsTest";
await claim(sam);
await claim(niels);
console.log(`identities: Sam=${sam.handle} Niels=${niels.handle}`);

const tmp = mkdtempSync(join(tmpdir(), "cc-e2e-"));
function ctxFor(me: Identity, contacts: any[], file: string): NetContext {
  return {
    me,
    book: { me: me.signPub, contacts },
    cache: openMailbox(":memory:") as Mailbox,
    client: createMailboxClient(URL, me, now),
    now,
    contactsPath: file,
  };
}
const samCtx = ctxFor(
  sam,
  [{ name: "Niels", signPub: niels.signPub, boxPub: niels.boxPub }],
  join(tmp, "sam.json"),
);
const nielsCtx = ctxFor(
  niels,
  [{ name: "Sam", signPub: sam.signPub, boxPub: sam.boxPub }],
  join(tmp, "niels.json"),
);

// ---- 1. send / receive (+ reply) -------------------------------------------
console.log("\n[1] send / receive");
const sent = await sendMessage(samCtx, { to: "Niels", body: "yo, e2e test 1" });
assert.ok(sent.ok, `send should succeed: ${JSON.stringify(sent)}`);
await sync(nielsCtx);
let nUnread = unreadFor(nielsCtx.cache, niels.signPub);
assert.equal(nUnread.length, 1, "Niels should have exactly 1 message");
assert.equal(nUnread[0]!.body, "yo, e2e test 1", "body should round-trip decrypted");
console.log(`  ✓ Niels received: "${nUnread[0]!.body}"`);

await sendMessage(nielsCtx, { in_reply_to: nUnread[0]!.id, body: "got it — replying" });
await sync(samCtx);
const sUnread = unreadFor(samCtx.cache, sam.signPub);
assert.equal(sUnread.length, 1, "Sam should receive the reply");
assert.equal(sUnread[0]!.body, "got it — replying");
console.log(`  ✓ Sam received reply: "${sUnread[0]!.body}"`);

// ---- 2. push delivery (warmer + /connect + wake) ---------------------------
console.log("\n[2] push delivery (warmer + /connect + wake)");
// Clear Niels's existing unread so we detect only the NEW pushed message.
for (const m of unreadFor(nielsCtx.cache, niels.signPub)) markRead(nielsCtx.cache, m.id, now());

process.env.MESSENGER_NOTIFY = "0"; // keep the test run silent — no desktop popups
const stop = startWarmer(nielsCtx, {
  mailboxUrl: URL,
  now,
  pendingPath: join(tmpdir(), `clim-live-pending-${process.pid}.json`),
  ackPath: join(tmpdir(), `clim-live-ack-${process.pid}.json`),
  settingsPath: join(tmpdir(), `clim-live-settings-${process.pid}.json`),
  chatLockPath: join(tmpdir(), `clim-live-chatlock-${process.pid}`),
});
await sleep(2500); // let the socket connect + the open catch-up drain settle
console.log("  warmer connected; sending while NOT manually syncing...");

const pushSent = await sendMessage(samCtx, { to: "Niels", body: "PUSH ping" });
assert.ok(pushSent.ok, "push send should succeed");

let deliveredMs = -1;
for (let i = 0; i < 16; i++) {
  await sleep(500);
  if (unreadFor(nielsCtx.cache, niels.signPub).some((m) => m.body === "PUSH ping")) {
    deliveredMs = (i + 1) * 500;
    break;
  }
}
stop();
assert.ok(
  deliveredMs >= 0,
  "pushed message should arrive via wake within 8s (fallback poll is 60s)",
);
console.log(`  ✓ pushed message arrived in ~${deliveredMs}ms via wake (poll backstop is 60s)`);

console.log("\nALL E2E CHECKS PASSED ✓");
process.exit(0);
