// Phase 1 MCP server: networked + encrypted. Bodies are sealed and travel
// through the hosted mailbox.
// Run as:  MESSENGER_USER=sam MESSENGER_MAILBOX_URL=http://localhost:8787 node src/server-net.ts
//
// The server boots even with NO identity on the device: in that state only
// `create_account` works (the rest report `no_account`), so a brand-new user
// can mint their identity + 6-char code from inside any CLI — no `npm run init`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { initCrypto, generateIdentity } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts } from "./contacts.ts";
import { openMailbox, unreadFor, markRead } from "./db.ts";
import { createMailboxClient, type MailboxClient } from "./mailbox-client.ts";
import { encodeKey, randomHandle } from "./key-code.ts";
import { enableService, disableService, statusService } from "./service.ts";
import { currentUser, setCurrentUser } from "./current-user.ts";
import {
  addContact,
  draftReply,
  messagesAvailable,
  readMessage,
  sendMessage,
  sync,
  type NetContext,
} from "./core-net.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mailboxUrl = process.env.MESSENGER_MAILBOX_URL ?? "http://localhost:8787";
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await initCrypto();

// A resolved identity + everything bound to it. Built lazily so the server can
// start with no account and create one on demand (create_account).
function buildSession(user: string) {
  const userDir = join(ROOT, "users", user);
  const contactsPath = join(userDir, "contacts.json");
  const me = loadIdentity(join(userDir, "identity.json"));
  const book = loadContacts(contactsPath);
  const cache = openMailbox(join(userDir, "inbox.db"));
  const ctx: NetContext = {
    me,
    book,
    cache,
    client: createMailboxClient(mailboxUrl, me, now),
    now,
    contactsPath,
  };
  const serviceOpts = {
    user: me.handle ?? user, // service IDs key on the stable handle, not the name
    mailboxUrl,
    watchPath: join(ROOT, "src", "watch.ts"),
    nodePath: process.execPath,
  };
  return { user, me, book, cache, ctx, serviceOpts };
}

let S: ReturnType<typeof buildSession> | null = null;
const existing = currentUser(ROOT);
if (existing) {
  try {
    S = buildSession(existing);
  } catch (e) {
    console.error(`Found user "${existing}" but couldn't load identity: ${(e as Error).message}`);
  }
}

// Claim a free 6-char handle in the registry (retries on collision).
async function claimHandle(client: MailboxClient): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const candidate = randomHandle(randomBytes(8));
    if ((await client.registerHandle(candidate)) === "ok") return candidate;
  }
  throw new Error("couldn't find a free handle after several tries");
}

// Behavior travels WITH the server (MCP `instructions`, sent on connect) so it
// works in any MCP-capable CLI — not just Claude Code's CLAUDE.md. Every major
// agent CLI surfaces these instructions to its model.
const INSTRUCTIONS = `You are the user's personal CLI messenger, backed by the cli-chat MCP server.

GETTING STARTED: a tool returning \`no_account\` means this device has no account
yet. Just fix it automatically — call \`create_account\` (pass name=their name if
the user gave one, otherwise let it default to the OS login name), then retry
whatever they were doing. You don't need to ask permission for this. If the user
explicitly asks to be set up ("set me up as Sam"), do the same. After creating,
report the new 6-char code in one line so they can share it. If they already have
an account, \`create_account\` just returns their existing code.

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

LISTENING: when the user asks you to "wait for", "watch for", "listen for", or
"keep an eye out for" incoming messages, call \`listen_for_messages\`. It blocks
up to ~25s and returns any new mail (already marked read). After it returns —
whether it found messages or was idle — call it AGAIN to keep listening, and keep
looping until the user tells you to stop. Report each message as it arrives and
offer to reply. This is intentionally NOT silent: each return is a turn the user
sees.

AUTOMATIC DELIVERY: new mail already surfaces in-chat — on session start and,
where the host supports it, each time the user sends a message. Do NOT
proactively offer background notifications. Only call \`enable_auto_delivery\` if
the user EXPLICITLY asks to be alerted while no CLI is open (it's a background
watcher with opt-in desktop notifications). \`disable_auto_delivery\` /
\`delivery_status\` manage it.

OTHER: \`add_contact\` saves a person from their code; \`list_contacts\` shows the
user's saved address book; \`my_key\` returns the user's own 6-char code to share.

RENAMING: when the user says "rename Niels to Bob" (or "call Niels something
else"), call \`list_contacts\`, take that contact's \`fullKey\`, then call
\`add_contact\` with name="Bob" and key=that fullKey. Saving a name against a key
already on file replaces the old entry, so it renames in place with no duplicate
and no need to ask the user for a code. Confirm in one line ("Renamed Niels to
Bob.").

Always keep the human in control of what's sent.`;

const server = new McpServer({ name: "cli-chat", version: "0.2.0" }, { instructions: INSTRUCTIONS });
const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
// Returned by any identity-requiring tool when no account exists yet.
const noAccount = () =>
  ok({
    ok: false,
    reason: "no_account",
    note: "No account on this device yet. Call create_account to generate your identity and 6-char code.",
  });

server.registerTool(
  "create_account",
  {
    title: "Create your account and get your 6-char code",
    description:
      "Set up the USER'S OWN identity on this device: generate their keypair " +
      "(private keys never leave the machine), claim a short 6-character code " +
      "(their 'number') in the registry, and return it to share. Use when the " +
      "user wants to get set up / join / get their code, or when another tool " +
      "reported `no_account`. Idempotent: if they already have an account it just " +
      "returns their existing code. (This is for the user themselves — to save " +
      "OTHER people, use add_contact.)",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("What to call this user, e.g. 'Sam'. Defaults to the OS login name."),
    },
  },
  async ({ name }) => {
    if (S) {
      let changed = false;
      if (name && name.trim() && S.me.name !== name.trim()) {
        S.me.name = name.trim(); // let the user (re)set their display name
        changed = true;
      } else if (!S.me.name) {
        S.me.name = S.user; // backfill from the folder name for older identities
        changed = true;
      }
      if (!S.me.handle) {
        S.me.handle = await claimHandle(S.ctx.client);
        changed = true;
      }
      if (changed) {
        writeFileSync(
          join(ROOT, "users", S.user, "identity.json"),
          JSON.stringify(S.me, null, 2) + "\n",
        );
      }
      return ok({
        ok: true,
        created: false,
        name: S.me.name,
        handle: S.me.handle,
        fullKey: encodeKey(S.me.signPub, S.me.boxPub),
        note: "You already have an account — this is your code to share.",
      });
    }

    // Display name is cosmetic; the identity is keyed on disk by its handle.
    const display =
      (name ?? process.env.MESSENGER_USER ?? userInfo().username ?? "me").trim() || "me";
    const id = generateIdentity();
    id.name = display;
    // Claim the handle FIRST — it's the directory key, and an account isn't
    // usable without a code anyway. (Throws if the registry is unreachable.)
    id.handle = await claimHandle(createMailboxClient(mailboxUrl, id, now));

    const userDir = join(ROOT, "users", id.handle);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "identity.json"), JSON.stringify(id, null, 2) + "\n");
    writeFileSync(
      join(userDir, "contacts.json"),
      JSON.stringify({ me: id.signPub, contacts: [] }, null, 2) + "\n",
    );
    setCurrentUser(ROOT, id.handle);
    S = buildSession(id.handle);
    return ok({
      ok: true,
      created: true,
      name: S.me.name,
      handle: S.me.handle,
      fullKey: encodeKey(S.me.signPub, S.me.boxPub),
      note: `Account ready. Share this 6-character code so people can message you: ${S.me.handle}`,
    });
  },
);

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
  async ({ to, body, key }) => (S ? ok(await sendMessage(S.ctx, { to, body, key })) : noAccount()),
);

server.registerTool(
  "add_contact",
  {
    title: "Save or rename a contact",
    description:
      "Remember a person by name from the key code they shared, so the user can " +
      "later just say 'write <name>'. Use when the user says something like " +
      "'add my mate Sam, his key is …'. ALSO renames an existing contact: saving " +
      "a name against a key that's already on file REPLACES the old entry (the " +
      "book is upserted by key, not name), so there's no duplicate. To rename " +
      "(e.g. 'rename Niels to Bob'), first call `list_contacts`, copy that " +
      "contact's `fullKey`, then call this with name=the new name and key=that " +
      "fullKey. No need to ask the user for a code — it's already saved.",
    inputSchema: {
      name: z.string().describe("What to call them, e.g. 'Sam'"),
      key: z.string().describe("Their key code (a long string of letters and numbers)"),
    },
  },
  async ({ name, key }) => (S ? ok(await addContact(S.ctx, { name, key })) : noAccount()),
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
    S
      ? ok({
          name: S.me.name ?? S.user,
          handle: S.me.handle ?? null,
          note: S.me.handle ? undefined : "No handle yet — call create_account to claim one.",
          fullKey: encodeKey(S.me.signPub, S.me.boxPub),
        })
      : noAccount(),
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
    S
      ? ok({
          count: S.book.contacts.length,
          contacts: S.book.contacts.map((c) => ({
            name: c.name,
            aliases: c.aliases ?? [],
            fullKey: c.signPub && c.boxPub ? encodeKey(c.signPub, c.boxPub) : null,
          })),
        })
      : noAccount(),
);

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
  async () => (S ? ok(enableService(S.serviceOpts)) : noAccount()),
);

server.registerTool(
  "disable_auto_delivery",
  {
    title: "Turn off automatic background delivery",
    description: "Remove the background delivery service.",
    inputSchema: {},
  },
  async () => (S ? ok(disableService(S.user)) : noAccount()),
);

server.registerTool(
  "delivery_status",
  {
    title: "Check automatic delivery status",
    description: "Report whether background auto-delivery is on for this user.",
    inputSchema: {},
  },
  async () => (S ? ok(statusService(S.user)) : noAccount()),
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
  async () => (S ? ok(await messagesAvailable(S.ctx)) : noAccount()),
);

server.registerTool(
  "listen_for_messages",
  {
    title: "Wait for incoming messages (long-poll loop)",
    description:
      "Block for up to ~25 seconds waiting for new mail, then return it (already " +
      "marked read) or report idle if none arrived. This is the building block of " +
      "a listening loop: after it returns, call it AGAIN to keep listening, and " +
      "repeat until the user says to stop. Portable across CLIs and intentionally " +
      "not silent — each return is a turn the user sees. Use when the user asks to " +
      "wait for / watch for / keep an eye out for messages.",
    inputSchema: {},
  },
  async () => {
    if (!S) return noAccount();
    const deadline = now() + 25_000;
    for (;;) {
      await sync(S.ctx);
      const rows = unreadFor(S.cache, S.me.signPub);
      if (rows.length > 0) {
        const messages = rows.map((m) => {
          markRead(S!.cache, m.id, now());
          return {
            id: m.id,
            from: (S!.book.contacts.find((c) => c.signPub === m.sender)?.name ?? m.sender),
            body: m.body,
            at: m.created_at,
            in_reply_to: m.in_reply_to,
          };
        });
        return ok({
          status: "messages",
          count: messages.length,
          messages,
          note: "Report these and offer to reply (draft_reply). Call listen_for_messages again to keep listening.",
        });
      }
      if (now() >= deadline) {
        return ok({
          status: "idle",
          count: 0,
          note: "No new messages in the last ~25s. Call listen_for_messages again to keep listening, or stop if the user is done.",
        });
      }
      await sleep(3_000);
    }
  },
);

server.registerTool(
  "read_message",
  {
    title: "Read a waiting message",
    description: "Read a decrypted message by id (or oldest unread). Marks it read.",
    inputSchema: { id: z.string().optional().describe("Message id; omit for oldest unread") },
  },
  async ({ id }) => (S ? ok(await readMessage(S.ctx, { id })) : noAccount()),
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
  async ({ in_reply_to, body }) =>
    S ? ok(await draftReply(S.ctx, { in_reply_to, body })) : noAccount(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  S
    ? `cli-chat (Phase 1) up as "${S.user}" → mailbox ${mailboxUrl}`
    : `cli-chat (Phase 1) up with NO account → mailbox ${mailboxUrl} (call create_account)`,
);
