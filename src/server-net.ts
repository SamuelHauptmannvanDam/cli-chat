// Phase 1 MCP server: networked + encrypted. Same four tools as Phase 0, but
// bodies are sealed and travel through the hosted mailbox.
// Run as:  MESSENGER_USER=sam MESSENGER_MAILBOX_URL=http://localhost:8787 node src/server-net.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initCrypto } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts } from "./contacts.ts";
import { openMailbox } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { encodeKey } from "./key-code.ts";
import { enableService, disableService, statusService } from "./service.ts";
import { currentUser } from "./current-user.ts";
import {
  addContact,
  draftReply,
  messagesAvailable,
  readMessage,
  sendMessage,
  type NetContext,
} from "./core-net.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const user = currentUser(ROOT);
if (!user)
  throw new Error(
    "No identity selected. Run `npm run init` to create one (it becomes this " +
      "device's default), or set MESSENGER_USER to pick among several.",
  );
const mailboxUrl = process.env.MESSENGER_MAILBOX_URL ?? "http://localhost:8787";

await initCrypto();

const userDir = join(ROOT, "users", user);
const contactsPath = join(userDir, "contacts.json");
const me = loadIdentity(join(userDir, "identity.json"));
const book = loadContacts(contactsPath);
const cache = openMailbox(join(userDir, "inbox.db"));
const now = () => Date.now();

const ctx: NetContext = {
  me,
  book,
  cache,
  client: createMailboxClient(mailboxUrl, me, now),
  now,
  contactsPath,
};

// Behavior travels WITH the server (MCP `instructions`, sent on connect) so it
// works in any MCP-capable CLI — not just Claude Code's CLAUDE.md. Every major
// agent CLI surfaces these instructions to its model.
const INSTRUCTIONS = `You are the user's personal CLI messenger, backed by the cli-chat MCP server.

AT THE START OF A SESSION: if your host already injected an \`[inbox] …\` block
(a startup hook fetched and displayed the waiting mail), do NOT repeat it or
re-fetch it — just act on the user's next input. Otherwise call
\`messages_available\`, and for anything waiting call \`read_message\` and read it
out in full ONCE. Never re-print messages the host already showed, and never ask
"want me to read it?" or "want to reply?".

REPLYING: when the user's input answers a shown message (e.g. "reply not much",
"tell him yes", or just "not much"), send it immediately with \`draft_reply\`
(in_reply_to = that message's id) and confirm in one line. Only pause to ask if
you're missing a fact you can't infer.

REPLYING: draft a reply and send it with \`draft_reply\` (in_reply_to = the
message id). Don't ask "want me to send this?" — just send, then say what you
sent. The ONE exception: if the reply needs a fact you don't have (the user's
availability, a yes/no decision, a preference), ask that one question first, then
send once they answer. Never invent the answer.

SENDING by name: when the user says "write <name>: ..." call \`send_message\`
right away, then report what you sent. Only stop if it returns no_contact or
ambiguous.

MESSAGING SOMEONE NEW: people share a short 6-character code. When the user says
"write Sam at AbC123: hey", call \`send_message\` with to="Sam", body=the message,
key="AbC123". It saves them, so next time just "write Sam".

AUTOMATIC DELIVERY: new mail already surfaces in-chat — on session start and,
where the host supports it, each time the user sends a message. Do NOT
proactively offer background notifications. Only call \`enable_auto_delivery\` if
the user EXPLICITLY asks to be alerted while no CLI is open (it's a background
watcher with opt-in desktop notifications). \`disable_auto_delivery\` /
\`delivery_status\` manage it.

OTHER: \`add_contact\` saves a person from their code; \`list_contacts\` shows the
user's saved address book; \`my_key\` returns the user's own 6-char code to share.
Always keep the human in control of what's sent.`;

const server = new McpServer({ name: "cli-chat", version: "0.2.0" }, { instructions: INSTRUCTIONS });
const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

server.registerTool(
  "send_message",
  {
    title: "Send an encrypted message by name or key",
    description:
      "Seal a message and post it to the hosted mailbox. Normally pass `to` = a " +
      "known contact name. To message someone NEW, the user gives you their key " +
      "code (a long string of letters and numbers) — pass it as `key` and put " +
      "their name in `to`; they'll be saved as a contact so next time just use " +
      "the name. Returns the resolved contact, or asks you to disambiguate.",
    inputSchema: {
      to: z.string().describe("Contact name, e.g. 'Sam'"),
      body: z.string().describe("The message text (encrypted end-to-end)"),
      key: z
        .string()
        .optional()
        .describe("Key code for a new person (long letters+numbers); saves them under `to`"),
    },
  },
  async ({ to, body, key }) => ok(await sendMessage(ctx, { to, body, key })),
);

server.registerTool(
  "add_contact",
  {
    title: "Save a contact from their key code",
    description:
      "Remember a person by name from the key code they shared, so the user can " +
      "later just say 'write <name>'. Use when the user says something like " +
      "'add my mate Sam, his key is …'.",
    inputSchema: {
      name: z.string().describe("What to call them, e.g. 'Sam'"),
      key: z.string().describe("Their key code (a long string of letters and numbers)"),
    },
  },
  async ({ name, key }) => ok(await addContact(ctx, { name, key })),
);

server.registerTool(
  "my_key",
  {
    title: "Show my own code to share",
    description:
      "Return the user's own short handle (a 6-character code) to hand to anyone " +
      "who wants to message them. Use when the user asks 'what's my " +
      "key/number/handle/invite?'.",
    inputSchema: {},
  },
  async () =>
    ok({
      name: user,
      handle: me.handle ?? null,
      note: me.handle ? undefined : "No handle yet — run `node src/init-identity.ts` to get one.",
      fullKey: encodeKey(me.signPub, me.boxPub),
    }),
);

server.registerTool(
  "list_contacts",
  {
    title: "List my saved contacts",
    description:
      "Return all people the user has saved, with the name to address them by, " +
      "any aliases, and their shareable key. Use when the user asks 'who are my " +
      "contacts?', 'who can I message?', or 'show my address book'.",
    inputSchema: {},
  },
  async () =>
    ok({
      count: book.contacts.length,
      contacts: book.contacts.map((c) => ({
        name: c.name,
        aliases: c.aliases ?? [],
        fullKey: c.signPub && c.boxPub ? encodeKey(c.signPub, c.boxPub) : null,
      })),
    }),
);

// --- automatic background delivery (cross-OS service) ----------------------
const serviceOpts = {
  user,
  mailboxUrl,
  watchPath: join(ROOT, "src", "watch.ts"),
  nodePath: process.execPath,
};

server.registerTool(
  "enable_auto_delivery",
  {
    title: "Turn on automatic background delivery",
    description:
      "Install a background service that polls for new mail while no CLI is open. " +
      "Use ONLY when the user explicitly asks to be alerted outside the CLI — " +
      "in-chat updates (on open + each turn) are the default and need no service. " +
      "Desktop notifications are opt-in (MESSENGER_NOTIFY=1). Installing a " +
      "background service is powerful — expect a permission prompt.",
    inputSchema: {},
  },
  async () => ok(enableService(serviceOpts)),
);

server.registerTool(
  "disable_auto_delivery",
  {
    title: "Turn off automatic background delivery",
    description: "Remove the background delivery service.",
    inputSchema: {},
  },
  async () => ok(disableService(user)),
);

server.registerTool(
  "delivery_status",
  {
    title: "Check automatic delivery status",
    description: "Report whether background auto-delivery is on for this user.",
    inputSchema: {},
  },
  async () => ok(statusService(user)),
);

server.registerTool(
  "messages_available",
  {
    title: "Check for waiting messages",
    description:
      "Proactive inbox signal. Pulls and decrypts any new mail, then returns the " +
      "count and previews of unread messages. Call this when the CLI opens.",
    inputSchema: {},
  },
  async () => ok(await messagesAvailable(ctx)),
);

server.registerTool(
  "read_message",
  {
    title: "Read a waiting message",
    description: "Read a decrypted message by id (or oldest unread). Marks it read.",
    inputSchema: { id: z.string().optional().describe("Message id; omit for oldest unread") },
  },
  async ({ id }) => ok(await readMessage(ctx, { id })),
);

server.registerTool(
  "draft_reply",
  {
    title: "Send an encrypted reply",
    description:
      "Reply to a message, sealed and threaded. Draft it yourself; if it needs a " +
      "fact you lack (the human's availability, a decision), ask the human first.",
    inputSchema: {
      in_reply_to: z.string().describe("Id of the message being replied to"),
      body: z.string().describe("The reply text"),
    },
  },
  async ({ in_reply_to, body }) => ok(await draftReply(ctx, { in_reply_to, body })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`cli-chat (Phase 1) up as "${user}" → mailbox ${mailboxUrl}`);
