// The real deal: two MCP server PROCESSES (Sam and Niels) over stdio, each with
// its own isolated state, talking to the deployed mailbox over HTTP. This is the
// two-Claude-Code-terminals path, exercised through the actual MCP tools.
//
// Self-contained: each process gets a throwaway MESSENGER_HOME and mints its own
// identity via create_account (no `npm run setup` / pre-seeded users/ needed), so
// it touches the live registry/mailbox. Push is disabled (MESSENGER_PUSH=0) — this
// test covers the tool layer; live-push.ts covers the warmer/push path.
//
// Run:  node test/e2e/live-net-mcp.ts
//   (override target with MESSENGER_MAILBOX_URL=http://localhost:8787)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveMailboxUrl } from "../../src/config.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const url = resolveMailboxUrl(); // hosted worker by default; MESSENGER_MAILBOX_URL overrides
const homes: string[] = [];

async function connect(label: string): Promise<Client> {
  const home = mkdtempSync(join(tmpdir(), `cc-mcp-${label}-`));
  homes.push(home);
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(ROOT, "src", "server-net.ts")],
    env: {
      ...process.env,
      MESSENGER_HOME: home, // isolated identity/contacts/cache
      MESSENGER_MAILBOX_URL: url,
      MESSENGER_PUSH: "0", // tool-layer test; push is covered by live-push.ts
      MESSENGER_USER: "", // no pre-existing identity — create_account mints one
    },
  });
  const client = new Client({ name: `${label}-cli`, version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0]!.text);
}

const sam = await connect("sam");
const niels = await connect("niels");
console.log(`Live MCP round-trip over the mailbox (${url})\n`);

// Each device mints its own identity + 6-char code.
const samAcct = await call(sam, "create_account", { name: "Sam" });
const nielsAcct = await call(niels, "create_account", { name: "Niels" });
assert.ok(samAcct.handle && nielsAcct.handle, "both should get handles");
console.log(`accounts: Sam=${samAcct.handle} Niels=${nielsAcct.handle}`);

// Niels saves Sam so he can resolve the sender and reply (sealed boxes don't
// carry the sender's box key — it comes from the contact book).
await call(niels, "add_contact", { name: "Sam", key: samAcct.fullKey });

// 1. Sam → Niels by code (saves Niels on Sam's side).
const sent = await call(sam, "send_message", {
  to: "Niels",
  body: "yo let's plan a LAN, when are you free?",
  key: nielsAcct.fullKey,
});
assert.ok(sent.ok, `send_message should succeed: ${JSON.stringify(sent)}`);
console.log(`1. Sam → send_message: sealed + sent to ${sent.to.name}`);

// 2-3. Niels sees + reads it.
const avail = await call(niels, "messages_available");
assert.equal(avail.count, 1, "Niels should have 1 message");
console.log(`2. Niels → messages_available: ${avail.count} from ${avail.messages[0]?.from}`);
const read = await call(niels, "read_message", { id: avail.messages[0].id });
assert.equal(read.body, "yo let's plan a LAN, when are you free?", "body should round-trip");
console.log(`3. Niels → read_message: "${read.body}"`);

// 4. Niels replies, threaded.
const reply = await call(niels, "draft_reply", {
  in_reply_to: sent.id,
  body: "Free Sat + Sun next week — lock it in.",
});
assert.ok(reply.ok ?? reply.id, `draft_reply should succeed: ${JSON.stringify(reply)}`);
console.log(`4. Niels → draft_reply: sealed back to Sam`);

// 5. Sam receives the threaded reply.
const samInbox = await call(sam, "messages_available");
assert.equal(samInbox.count, 1, "Sam should have the reply");
const samRead = await call(sam, "read_message", { id: samInbox.messages[0].id });
assert.equal(samRead.body, "Free Sat + Sun next week — lock it in.");
assert.equal(samRead.in_reply_to, sent.id, "reply should be threaded to the original");
console.log(`5. Sam → read_message: "${samRead.body}" (threaded=${samRead.in_reply_to === sent.id})`);

await sam.close();
await niels.close();
for (const h of homes) rmSync(h, { recursive: true, force: true });
console.log("\nLive MCP round-trip complete — ALL CHECKS PASSED ✓");
