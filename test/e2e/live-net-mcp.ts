// The real deal: two MCP server PROCESSES (Sam and Niels) over stdio, each with
// its own isolated state, talking to the deployed mailbox over HTTP. This is the
// two-Claude-Code-terminals path, exercised through the actual MCP tools.
//
// Self-contained: each process gets a throwaway MESSENGER_HOME and mints its own
// account via the magic-link `login` (no `npm run setup` / pre-seeded users/
// needed). Creating an account needs the link CLICKED, so this must run against
// a dev mailbox (exposeMagicLink) — the script clicks the devLink itself. Push
// is disabled (MESSENGER_PUSH=0) — this test covers the tool layer;
// live-push.ts covers the warmer/push path.
//
// Run:  PORT=18787 npm run dev:mailbox
//       MESSENGER_MAILBOX_URL=http://localhost:18787 node test/e2e/live-net-mcp.ts

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

async function connect(label: string, extraEnv: Record<string, string> = {}, reuseHome?: string): Promise<Client> {
  const home = reuseHome ?? mkdtempSync(join(tmpdir(), `cc-mcp-${label}-`));
  if (!reuseHome) homes.push(home);
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(ROOT, "src", "server-net.ts")],
    env: {
      ...process.env,
      MESSENGER_HOME: home, // isolated identity/contacts/cache
      MESSENGER_MAILBOX_URL: url,
      MESSENGER_PUSH: "0", // tool-layer test; push is covered by live-push.ts
      MESSENGER_USER: "", // no pre-existing identity — login mints one
      MESSENGER_FEEDBACK_HANDLE: "", // no feedback seed unless a step opts in (step 6)
      ...extraEnv,
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

// Drive the full magic-link login through the MCP tool: send the link, "click"
// it via the devLink (only a dev mailbox with exposeMagicLink returns one),
// then finish with the poll_id + name to create the account.
async function loginAs(client: Client, email: string, name: string) {
  const start = await call(client, "login", { email });
  assert.equal(start.reason, "sent");
  assert.ok(start.devLink, "no devLink — run against a dev mailbox (npm run dev:mailbox)");
  await fetch(start.devLink);
  const named = await call(client, "login", { poll_id: start.poll_id });
  assert.equal(named.reason, "need_name");
  const acc = await call(client, "login", { poll_id: start.poll_id, name });
  assert.equal(acc.ok, true, `login should create the account: ${JSON.stringify(acc)}`);
  return acc;
}

const sam = await connect("sam");
const niels = await connect("niels");
console.log(`Live MCP round-trip over the mailbox (${url})\n`);

// Each device mints its own account + 6-char code via login.
const samAcct = await loginAs(sam, "sam-mcp@example.com", "Sam");
const nielsAcct = await loginAs(niels, "niels-mcp@example.com", "Niels");
assert.ok(samAcct.handle && nielsAcct.handle, "both should get handles");
console.log(`accounts: Sam=${samAcct.handle} Niels=${nielsAcct.handle}`);

// Niels saves Sam so he can resolve the sender and reply (sealed boxes don't
// carry the sender's box key — it comes from the contact book).
await call(niels, "update_contact", { action: "add", name: "Sam", key: samAcct.fullKey });

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
const read = await call(niels, "read_messages", { id: avail.messages[0].id });
assert.equal(read.body, "yo let's plan a LAN, when are you free?", "body should round-trip");
console.log(`3. Niels → read_messages(id): "${read.body}"`);

// 4. Niels replies, threaded.
const reply = await call(niels, "send_message", {
  in_reply_to: sent.id,
  body: "Free Sat + Sun next week — lock it in.",
});
assert.ok(reply.ok ?? reply.id, `reply should succeed: ${JSON.stringify(reply)}`);
console.log(`4. Niels → reply: sealed back to Sam`);

// 5. Sam receives the threaded reply.
const samInbox = await call(sam, "messages_available");
assert.equal(samInbox.count, 1, "Sam should have the reply");
const samRead = await call(sam, "read_messages", { id: samInbox.messages[0].id });
assert.equal(samRead.body, "Free Sat + Sun next week — lock it in.");
assert.equal(samRead.in_reply_to, sent.id, "reply should be threaded to the original");
console.log(`5. Sam → read_messages(id): "${samRead.body}" (threaded=${samRead.in_reply_to === sent.id})`);

// 6. The feedback seed: a brand-new account is born with the project's feedback
// contact when the configured handle resolves. A throwaway account stands in
// for the real feedback account; a fresh device is pointed at its handle.
const fb = await connect("feedback");
const fbAcct = await loginAs(fb, "feedback-mcp@example.com", "cli-chat feedback");
const newbie = await connect("newbie", { MESSENGER_FEEDBACK_HANDLE: fbAcct.handle });
const newbieAcct = await loginAs(newbie, "newbie-mcp@example.com", "Newbie");
assert.ok(
  newbieAcct.note.includes("feedback"),
  `created note should mention the feedback contact: ${newbieAcct.note}`,
);
const newbieBook = await call(newbie, "contacts");
const seeded = [...(newbieBook.active ?? []), ...(newbieBook.contacts ?? [])].find(
  (c: { name: string }) => c.name === "cli-chat feedback",
);
assert.ok(seeded, `new account should be born with the feedback contact: ${JSON.stringify(newbieBook)}`);
assert.equal(seeded.handle, fbAcct.handle, "seeded contact should carry the feedback handle");
console.log(`6. Newbie → born with "${seeded.name}" (${seeded.handle}) in the book`);

// Sam and Niels were created with seeding disabled — their books must be clean.
const samBook = await call(sam, "contacts");
assert.ok(
  ![...(samBook.active ?? []), ...(samBook.contacts ?? [])].some((c: { name: string }) => c.name === "cli-chat feedback"),
  "seeding disabled → no feedback contact",
);

// 7. Existing-account backfill: restart Sam's server (same home) pointed at the
// feedback handle — boot seeds his pre-existing book. The seed is fire-and-forget
// at boot, so poll briefly.
await sam.close();
const samAgain = await connect("sam-again", { MESSENGER_FEEDBACK_HANDLE: fbAcct.handle }, homes[0]);
let backfilled;
for (let i = 0; i < 20 && !backfilled; i++) {
  const b = await call(samAgain, "contacts");
  backfilled = [...(b.active ?? []), ...(b.contacts ?? [])].find(
    (c: { name: string }) => c.name === "cli-chat feedback",
  );
  if (!backfilled) await new Promise((r) => setTimeout(r, 250));
}
assert.ok(backfilled, "existing account should get the feedback contact on boot");
console.log(`7. Sam (existing account) → backfilled with "cli-chat feedback" on restart`);

await samAgain.close();
await niels.close();
await fb.close();
await newbie.close();
for (const h of homes) rmSync(h, { recursive: true, force: true });
console.log("\nLive MCP round-trip complete — ALL CHECKS PASSED ✓");
