// E2E of the history + auto-chat features (0.11/0.12) through REAL MCP server
// processes: history recall, assistant-marked replies, self-send escalations,
// remember/recall notes, thread files on disk, and the headless CLI send.
//
// Run against a local dev mailbox:
//   PORT=18787 npm run dev:mailbox
//   MESSENGER_MAILBOX_URL=http://localhost:18787 node test/e2e/live-features.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveMailboxUrl } from "../../src/config.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const URL = resolveMailboxUrl();
const homes: { label: string; home: string }[] = [];

async function connect(label: string): Promise<{ client: Client; home: string }> {
  const home = mkdtempSync(join(tmpdir(), `cc-e2e-${label}-`));
  homes.push({ label, home });
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(ROOT, "src", "server-net.ts")],
    env: {
      ...process.env,
      MESSENGER_HOME: home,
      MESSENGER_MAILBOX_URL: URL,
      MESSENGER_PUSH: "0",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: `probe-${label}`, version: "0.0.0" });
  await client.connect(transport);
  return { client, home };
}

const parse = (r: any) => JSON.parse(r.content[0].text);
const call = async (c: Client, name: string, args: any = {}) =>
  parse(await c.callTool({ name, arguments: args }));

// Drive the full magic-link login through the MCP tool: send the link, "click"
// it via the devLink (only a dev mailbox with exposeMagicLink returns one),
// then finish with the poll_id + name to create the account.
async function loginAs(c: Client, email: string, name: string) {
  const start = await call(c, "login", { email });
  assert.equal(start.reason, "sent");
  assert.ok(start.devLink, "no devLink — run against a dev mailbox (npm run dev:mailbox)");
  await fetch(start.devLink);
  const named = await call(c, "login", { poll_id: start.poll_id });
  assert.equal(named.reason, "need_name");
  const acc = await call(c, "login", { poll_id: start.poll_id, name });
  assert.equal(acc.ok, true, `login should create the account: ${JSON.stringify(acc)}`);
  return acc;
}

const sam = await connect("sam");
const niels = await connect("niels");

const samAcc = await loginAs(sam.client, "sam-e2e@example.com", "Sam Tester");
const nielsAcc = await loginAs(niels.client, "niels-e2e@example.com", "Niels Tester");
console.log(`accounts: Sam=${samAcc.handle} Niels=${nielsAcc.handle}`);

// 1. Sam asks Niels a question.
const sent = await call(sam.client, "send_message", {
  to: "Niels",
  body: "what env vars does the service need?",
  key: nielsAcc.handle,
});
assert.equal(sent.ok, true);
console.log("1. send_message: ok");

// 2. On Niels's side Sam is a STRANGER → held behind the new-handle gate (0.18):
//    tools return a name+handle summary only, and the user's accept reveals the
//    held batch. Then Niels replies AS ASSISTANT.
const avail = await call(niels.client, "messages_available", {});
assert.equal(avail.count, 0, "a stranger's first message must not flow");
assert.equal(avail.new_handles?.length, 1);
assert.equal(avail.new_handles[0].name, "Sam Tester");
assert.equal(avail.new_handles[0].count, 1);
const nielsContacts = await call(niels.client, "contacts", {});
assert.equal(nielsContacts.newHandles?.length, 1);
assert.equal(nielsContacts.newHandles[0].state, "pending");
assert.equal(nielsContacts.newHandles[0].held, 1);
const held = await call(niels.client, "respond_handle", { name: "Sam Tester", action: "accept" });
assert.equal(held.ok, true);
assert.equal(held.count, 1);
assert.match(held.note ?? "", /Accepted/);
const read = held.messages[0];
assert.match(read.body, /what env vars/);
const reply = await call(niels.client, "send_message", {
  in_reply_to: read.id,
  body: "REDIS_URL and API_KEY, see .env.example",
  as_assistant: true,
});
assert.equal(reply.ok, true);
console.log("2. new-handle gate (hold → summary → accept) + reply as_assistant: ok");

// 3. Sam reads the reply — visibly marked + metadata + resultNote guidance.
const got = await call(sam.client, "read_message", {});
assert.equal(got.answered_by, "assistant");
assert.match(got.body, /— Niels Tester's assistant$/);
assert.match(got.note ?? "", /assistant/i);
console.log("3. assistant mark round-trip: ok (visible + metadata + note)");

// 4. history on both sides, with q filter.
const h = await call(sam.client, "history", { with: "Niels", q: "REDIS" });
assert.equal(h.ok, true);
assert.equal(h.messages.length, 1);
assert.equal(h.messages[0].direction, "in");
assert.equal(h.messages[0].answered_by, "assistant");
const hAll = await call(niels.client, "history", {});
assert.equal(hAll.messages.length, 2);
console.log("4. history tool: ok (q filter, both directions)");

// 5. Thread files exist on disk with digest + tail.
const samThreads = join(sam.home, "users", samAcc.handle, "context", "threads");
const files = readdirSync(samThreads);
assert.equal(files.length, 1);
const page = readFileSync(join(samThreads, files[0]!), "utf8");
assert.match(page, /## Digest/);
assert.match(page, /→ me: what env vars/);
assert.match(page, /← .*REDIS_URL/);
console.log(`5. thread file: ok (${files[0]})`);

// 6. remember / recall.
await call(sam.client, "remember", { text: "Niels's staging URL is https://s.example", topic: "Niels", source: "Niels" });
const rec = await call(sam.client, "recall", { q: "staging" });
assert.equal(rec.notes.length, 1);
assert.match(rec.notes[0].content, /staging URL/);
console.log("6. remember/recall: ok");

// 7. Self-send (escalation shape) surfaces as "your assistant".
const esc = await call(sam.client, "send_message", {
  to: "me",
  body: "Niels asks when you're free — Sat or Sun?",
  as_assistant: true,
});
assert.equal(esc.ok, true);
assert.equal(esc.self, true);
const selfAvail = await call(sam.client, "messages_available", {});
assert.equal(selfAvail.count, 1);
assert.equal(selfAvail.messages[0].from, "your assistant");
const selfRead = await call(sam.client, "read_message", {});
assert.equal(selfRead.self, true);
assert.match(selfRead.note ?? "", /SELF-MAIL/);
console.log("7. self-send escalation: ok ('your assistant', self note)");

// 8. The three chat tools return the waker command; auto_chat quiet stamps the mode.
const chat = await call(sam.client, "auto_chat", { quiet: true });
assert.match(chat.command, /MESSENGER_CHAT_MODE=quiet/);
assert.match(chat.note ?? "", /WRITE SCOPE/);
assert.doesNotMatch(chat.note ?? "", /READ-ONLY DESK/);
const chatRO = await call(sam.client, "auto_chat", { read_only: true });
assert.match(chatRO.note ?? "", /READ-ONLY DESK/);
assert.doesNotMatch(chatRO.note ?? "", /WRITE SCOPE/);
const chatPlain = await call(sam.client, "chat", {});
assert.doesNotMatch(chatPlain.command, /MESSENGER_CHAT_MODE/);
assert.doesNotMatch(chatPlain.command, /MESSENGER_CHAT_PUBLIC/);
assert.match(chatPlain.note ?? "", /NEW-HANDLE GATE/);
const chatDraft = await call(sam.client, "auto_draft_chat", {});
assert.doesNotMatch(chatDraft.command, /MESSENGER_CHAT_MODE/);
assert.match(chatDraft.note ?? "", /AUTO DRAFT CHAT MODE/);
// The public variant: flag travels in the waker env, note flips gate → public.
const chatPub = await call(sam.client, "chat", { public: true });
assert.match(chatPub.command, /MESSENGER_CHAT_PUBLIC=1/);
assert.match(chatPub.note ?? "", /PUBLIC MODE/);
assert.doesNotMatch(chatPub.note ?? "", /NEW-HANDLE GATE/);
const autoPub = await call(sam.client, "auto_chat", { read_only: true, public: true });
assert.match(autoPub.command, /MESSENGER_CHAT_PUBLIC=1/);
assert.match(autoPub.note ?? "", /READ-ONLY DESK/);
assert.match(autoPub.note ?? "", /PUBLIC MODE/);
console.log("8. chat / auto_draft_chat / auto_chat wakers (incl. read_only + public): ok");

// 9. Headless CLI send from Niels's home → lands for Sam.
const out = execFileSync("node", [join(ROOT, "src", "server-net.ts"), "send", "Sam", "deploy", "landed,", "your", "move"], {
  env: { ...process.env, MESSENGER_HOME: niels.home, MESSENGER_MAILBOX_URL: URL, MESSENGER_PUSH: "0" },
  encoding: "utf8",
});
assert.match(out, /^sent /);
const cliGot = await call(sam.client, "read_message", {});
assert.match(cliGot.body, /deploy landed, your move/);
console.log("9. CLI send subcommand: ok");

// 10. contacts still renders (regression) and the me entry is intact.
const contacts = await call(sam.client, "contacts", {});
assert.equal(contacts.me.handle, samAcc.handle);
assert.equal(contacts.count >= 1, true);
console.log("10. contacts regression: ok");

console.log("\nALL NEW-FEATURE E2E CHECKS PASSED ✓");
for (const h of homes) rmSync(h.home, { recursive: true, force: true });
process.exit(0);
