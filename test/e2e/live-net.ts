// Phase 1 end-to-end: real Hono mailbox (in-process) + sealed-box E2E +
// signed-request auth. Proves Sam → Niels → reply back over the network, that
// the server stores only ciphertext, and that sender spoofing is rejected.

import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server-mailbox/app.ts";
import { nodeSqliteStore } from "../../server-mailbox/store.ts";
import { initCrypto, generateIdentity } from "../../src/crypto.ts";
import { openMailbox } from "../../src/db.ts";
import { createMailboxClient } from "../../src/mailbox-client.ts";
import type { ContactBook } from "../../src/contacts.ts";
import {
  draftReply,
  messagesAvailable,
  readMessage,
  sendMessage,
  type NetContext,
} from "../../src/core-net.ts";

await initCrypto();

const dir = mkdtempSync(join(tmpdir(), "cli-chat-net-"));
const serverDbPath = join(dir, "mailbox-server.db");
const now = () => Date.now();

// --- stand up the hosted mailbox on a real port ---------------------------
const app = createApp({ store: nodeSqliteStore(serverDbPath), now });
const httpServer = await new Promise<any>((res) => {
  const srv = serve({ fetch: app.fetch, port: 0 }, () => res(srv));
});
const port = httpServer.address().port;
const baseUrl = `http://localhost:${port}`;

// --- two identities + cross-referenced contact books ----------------------
const samId = generateIdentity();
const nielsId = generateIdentity();

const samBook: ContactBook = {
  me: samId.signPub,
  contacts: [{ name: "Niels", signPub: nielsId.signPub, boxPub: nielsId.boxPub }],
};
const nielsBook: ContactBook = {
  me: nielsId.signPub,
  contacts: [{ name: "Sam", signPub: samId.signPub, boxPub: samId.boxPub }],
};

const sam: NetContext = {
  me: samId,
  book: samBook,
  cache: openMailbox(":memory:"),
  client: createMailboxClient(baseUrl, samId, now),
  now,
};
const niels: NetContext = {
  me: nielsId,
  book: nielsBook,
  cache: openMailbox(":memory:"),
  client: createMailboxClient(baseUrl, nielsId, now),
  now,
};

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  console.log(`  ✓ ${label}`);
  passed++;
}

console.log("Phase 1 round-trip: encrypted, over the hosted mailbox\n");

const PLAINTEXT = "yo let's plan a LAN, when are you free?";

// 1. Sam seals + sends.
const sent = await sendMessage(sam, { to: "Niels", body: PLAINTEXT });
check("Sam seals and sends to Niels", sent.ok === true);
const sentId = sent.ok ? sent.id : "";

// 2. The server holds only ciphertext — never the plaintext.
const peek = new DatabaseSync(serverDbPath, { readOnly: true });
const stored = peek.prepare(`SELECT body, sender, recipient FROM messages WHERE id = ?`).get(sentId) as
  | { body: string; sender: string; recipient: string }
  | undefined;
peek.close();
check("server stored exactly one blob", !!stored);
check("stored body is NOT the plaintext", stored!.body !== PLAINTEXT);
check("stored body is base64 ciphertext", /^[A-Za-z0-9+/]+=*$/.test(stored!.body) && stored!.body.length > 20);
check("server is keyed by Niels's address", stored!.recipient === nielsId.signPub);

// 3. Niels's proactive inbox pulls + decrypts.
const avail = await messagesAvailable(niels);
check("Niels sees 1 message from Sam", avail.count === 1 && avail.messages[0]?.from === "Sam");
check("preview is the DECRYPTED text", avail.messages[0]?.preview === PLAINTEXT);

// 4. Read + clear.
const read = await readMessage(niels, { id: avail.messages[0]!.id });
check("Niels reads the decrypted body", read.ok === true && read.body === PLAINTEXT);
check("inbox clears after read", (await messagesAvailable(niels)).count === 0);

// 5. Grounded reply back to Sam, threaded.
const reply = await draftReply(niels, { in_reply_to: sentId, body: "Free Sat + Sun next week." });
check("Niels replies to Sam", reply.ok === true && reply.to.name === "Sam");

const samInbox = await messagesAvailable(sam);
check("Sam receives the reply", samInbox.count === 1 && samInbox.messages[0]!.from === "Niels");
const samRead = await readMessage(sam, {});
check("Sam reads availability", samRead.ok === true && samRead.body.includes("Sat + Sun"));
check("reply threads to the original", samRead.ok === true && samRead.in_reply_to === sentId);

// 6. Auth: an attacker can't post AS Sam (sign with own key, claim sender=Sam).
const attacker = generateIdentity();
const forger = createMailboxClient(baseUrl, attacker, now);
let rejected = false;
try {
  await forger.send({
    id: "forged-1",
    recipient: nielsId.signPub,
    sender: samId.signPub, // lie about who we are
    body: "spoofed",
    tags: null,
    created_at: now(),
    in_reply_to: null,
  });
} catch {
  rejected = true;
}
check("server rejects sender spoofing", rejected);

httpServer.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed — Phase 1 encrypted networked loop verified.`);
