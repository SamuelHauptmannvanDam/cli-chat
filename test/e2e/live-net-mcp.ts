// The real deal: two Phase 1 MCP server processes (as Sam and Niels) talking
// over HTTP to a running mailbox, with on-disk identities. This is exactly the
// path the two Claude Code terminals exercise. Assumes the mailbox is running
// at MESSENGER_MAILBOX_URL (default http://localhost:8787) and that
// `npm run setup` has generated users/sam and users/niels.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve, join } from "node:path";
import { rmSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const url = process.env.MESSENGER_MAILBOX_URL ?? "http://localhost:8787";

// Start each user with a clean inbox cache so the run is repeatable.
for (const u of ["sam", "niels"]) {
  rmSync(join(ROOT, "users", u, "inbox.db"), { force: true });
}

async function connect(user: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(ROOT, "src", "server-net.ts")],
    env: { ...process.env, MESSENGER_USER: user, MESSENGER_MAILBOX_URL: url },
  });
  const client = new Client({ name: `${user}-cli`, version: "0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { text: string }[])[0].text);
}

const sam = await connect("sam");
const niels = await connect("niels");

console.log(`Live Phase 1 over MCP + HTTP mailbox (${url})\n`);

const sent = await call(sam, "send_message", { to: "Niels", body: "yo let's plan a LAN, when are you free?" });
console.log("1. Sam → send_message:", sent.ok ? `sealed + sent to ${sent.to.name}` : sent);

const avail = await call(niels, "messages_available");
console.log(`2. Niels → messages_available: ${avail.count} from ${avail.messages[0]?.from}`);

const read = await call(niels, "read_message", { id: avail.messages[0].id });
console.log(`3. Niels → read_message: "${read.body}"`);

const reply = await call(niels, "draft_reply", { in_reply_to: sent.id, body: "Free Sat + Sun next week — lock it in." });
console.log(`4. Niels → draft_reply: sealed back to ${reply.to.name}`);

const samInbox = await call(sam, "messages_available");
const samRead = await call(sam, "read_message", { id: samInbox.messages[0].id });
console.log(`5. Sam → read_message: "${samRead.body}" (threaded=${samRead.in_reply_to === sent.id})`);

await sam.close();
await niels.close();
console.log("\nLive Phase 1 MCP round-trip complete.");
