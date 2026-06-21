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
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { initCrypto, generateIdentity } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts } from "./contacts.ts";
import { openMailbox, unreadFor, markRead } from "./db.ts";
import { createMailboxClient, type MailboxClient } from "./mailbox-client.ts";
import { encodeKey, randomHandle } from "./key-code.ts";
import { currentUser, setCurrentUser, resolveIdentity } from "./current-user.ts";
import { userDir as userDirOf, identityFile, contactsFile, inboxFile } from "./paths.ts";
import { resolveMailboxUrl } from "./config.ts";
import { startWarmer } from "./warmer.ts";
import {
  addContact,
  draftReply,
  messagesAvailable,
  readMessage,
  sendMessage,
  sync,
  type NetContext,
} from "./core-net.ts";

const mailboxUrl = resolveMailboxUrl();
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long a single `watch` long-poll blocks before returning `idle`. The MCP
// client (Claude Code) normally aborts a tool call after ~60s, but we emit a
// progress notification on every inner tick — clients that honor MCP progress
// reset their timeout on each one, so the call can safely outlive 60s. Keep the
// window modest anyway: while watch blocks, the agent can't process the user's
// next message (incl. "stop") until it returns. Override via MESSENGER_WATCH_MS.
const WATCH_MS = Number(process.env.MESSENGER_WATCH_MS ?? 50_000);

await initCrypto();

// A resolved identity + everything bound to it. Built lazily so the server can
// start with no account and create one on demand (create_account).
function buildSession(user: string) {
  const contactsPath = contactsFile(user);
  const me = loadIdentity(identityFile(user));
  const book = loadContacts(contactsPath);
  // The inbox cache is best-effort: NEVER let a transient open failure collapse
  // the session. The wasm SQLite VFS can refuse a cross-process open when another
  // live session of the SAME identity already holds the file; that used to throw,
  // get swallowed at boot (S=null), surface as a false `no_account`, and make the
  // agent mint a DUPLICATE identity. Identity is what matters here — fall back to a
  // temporary in-memory cache so the session still loads and reports the real code.
  let cache;
  try {
    cache = openMailbox(inboxFile(user));
  } catch (e) {
    console.error(
      `Inbox cache for "${user}" is busy (${(e as Error).message}); ` +
        `using a temporary in-memory cache for this session (another session may have it open).`,
    );
    cache = openMailbox(":memory:");
  }
  const ctx: NetContext = {
    me,
    book,
    cache,
    client: createMailboxClient(mailboxUrl, me, now),
    now,
    contactsPath,
  };
  return { user, me, book, cache, ctx };
}

let S: ReturnType<typeof buildSession> | null = null;
const existing = currentUser();
if (existing) {
  try {
    S = buildSession(existing);
  } catch (e) {
    console.error(`Found user "${existing}" but couldn't load identity: ${(e as Error).message}`);
  }
}

// Background push warmer (PUSH.md): a WebSocket to the inbox Durable Object that
// drains new mail into the cache without occupying the agent's turn. Runs for the
// active session; restarted when create_account establishes one. Opt out with
// MESSENGER_PUSH=0 (falls back to the on-open / per-prompt hook + watch tool).
let stopWarmer: (() => void) | null = null;
function ensureWarmer(): void {
  if (process.env.MESSENGER_PUSH === "0") return;
  if (stopWarmer) {
    stopWarmer();
    stopWarmer = null;
  }
  if (S) stopWarmer = startWarmer(S.ctx, { mailboxUrl, now });
}
ensureWarmer();

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

AT THE START OF A SESSION: a startup hook may inject an inbox notice telling you
how many messages are waiting and who they're from — but NOT the bodies (those
are given to you privately, hidden from the user). Do NOT print the bodies. Just
tell the user how many are waiting and from whom, then ASK if they want them read
("1 new message from Sam — want me to read it?"). Only when the user says yes
(e.g. "read it", "go on", "yes") do you print the message in full. Also, once per
session, you may add a short suggestion that they can have you watch for incoming
messages live with the \`watch\` tool. If no hook ran, call \`messages_available\`
to get the count and offer the same way.

REPLYING: when the user's input answers a message they've had read out (e.g.
"reply not much", "tell him yes", or just "not much"), send it immediately with
\`draft_reply\` (in_reply_to = that message's id) and confirm in one line. Only
pause to ask if you're missing a fact you can't infer.

REPLYING: draft a reply and send it with \`draft_reply\` (in_reply_to = the
message id). Don't ask "want me to send this?" — just send, then say what you
sent. The ONE exception: if the reply needs a fact you don't have (the user's
availability, a yes/no decision, a preference), ask that one question first, then
send once they answer. Never invent the answer.

SENDING by name: when the user says "write <name>: ..." call \`send_message\`
right away, then report what you sent. The resolver already matches partial names
(so "Niels" finds a saved "Niels - bankdata"). It only returns no_contact when
nothing matches at all — then offer to add them by code. It returns ambiguous
with a list of candidates when several match — name them and ask which; don't
guess.

MESSAGING SOMEONE NEW: people share a short 6-character code. When the user says
"write Sam at AbC123: hey", call \`send_message\` with to="Sam", body=the message,
key="AbC123". It saves them, so next time just "write Sam".

WATCHING: when the user says "watch" (or "watch for"/"wait for"/"listen for"/
"keep an eye out for" messages), call \`watch\`. It blocks up to ~50s and returns
any new mail (already marked read). After it returns — whether it found messages
or was idle — call it AGAIN to keep watching, and keep looping until the user
tells you to stop. On an idle return, re-call SILENTLY: print nothing to the user
(no "still watching" heartbeat). In watch mode the user has opted into hands-free
chat, so when mail arrives READ IT OUT IN FULL automatically (sender + body,
straight into the chat) and offer to reply — do NOT ask "want me to read it?"
here; that ask is only for the passive inbox notice.

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
        writeFileSync(identityFile(S.user), JSON.stringify(S.me, null, 2) + "\n");
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

    // Idempotency guard: if a selector (the requested name or the MESSENGER_USER
    // pin) already names an identity on disk, ADOPT it instead of minting a fresh
    // handle. Without this, a boot where buildSession failed — or a name pin that
    // didn't resolve at startup — silently spawns a duplicate account.
    const pin = process.env.MESSENGER_USER?.trim();
    for (const sel of [name?.trim(), pin].filter((s): s is string => !!s)) {
      const dir = resolveIdentity(sel);
      if (dir) {
        S = buildSession(dir);
        if (!pin) setCurrentUser(dir); // don't stomp another session's default
        ensureWarmer();
        return ok({
          ok: true,
          created: false,
          name: S.me.name,
          handle: S.me.handle,
          fullKey: encodeKey(S.me.signPub, S.me.boxPub),
          note: "You already have an account — this is your code to share.",
        });
      }
    }

    const id = generateIdentity();
    id.name = display;
    // Claim the handle FIRST — it's the directory key, and an account isn't
    // usable without a code anyway. (Throws if the registry is unreachable.)
    id.handle = await claimHandle(createMailboxClient(mailboxUrl, id, now));

    mkdirSync(userDirOf(id.handle), { recursive: true });
    writeFileSync(identityFile(id.handle), JSON.stringify(id, null, 2) + "\n");
    writeFileSync(
      contactsFile(id.handle),
      JSON.stringify({ me: id.signPub, contacts: [] }, null, 2) + "\n",
    );
    // Only become the device default when not explicitly pinned via MESSENGER_USER;
    // otherwise a second identity's setup would clobber the first session's .current.
    if (!process.env.MESSENGER_USER?.trim()) setCurrentUser(id.handle);
    S = buildSession(id.handle);
    ensureWarmer(); // start push delivery now that an account exists
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
      "known contact name; matching is partial, so a short name like 'Niels' " +
      "resolves a saved 'Niels - bankdata'. To message someone NEW, the user " +
      "gives you their key code (a long string of letters and numbers) — pass it " +
      "as `key` and put their name in `to`; they'll be saved as a contact so next " +
      "time just use the name. Returns the resolved contact; `no_contact` means " +
      "nothing matched (offer to add by code), `ambiguous` returns the candidates " +
      "to disambiguate.",
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
  "watch",
  {
    title: "Watch for incoming messages (long-poll loop)",
    description:
      "Block for up to ~50 seconds waiting for new mail, then return it (already " +
      "marked read) or report idle if none arrived. This is the building block of " +
      "a watch loop: after it returns, call it AGAIN to keep watching, and " +
      "repeat until the user says to stop. On an idle return, re-call SILENTLY — " +
      "print nothing to the user; only speak when mail actually arrives. Use when " +
      "the user asks to watch for / wait for / keep an eye out for messages.",
    inputSchema: {},
  },
  async (_args, extra) => {
    if (!S) return noAccount();
    const deadline = now() + WATCH_MS;
    const progressToken = extra?._meta?.progressToken;
    let ticks = 0;
    // The background warmer (PUSH.md) drains new mail into the cache via push, so
    // this loop just watches the LOCAL cache (cheap, ~1s granularity) rather than
    // hitting the network every tick. A periodic sync is kept as a backstop for
    // when push is off/unavailable (MESSENGER_PUSH=0 or the socket is down).
    await sync(S.ctx); // initial catch-up
    let sinceSync = 0;
    for (;;) {
      if (extra?.signal?.aborted) return ok({ status: "idle", count: 0, note: "Watch cancelled." });
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
          note: "Read these out in full (sender + body) and offer to reply (draft_reply). Call watch again to keep watching.",
        });
      }
      if (now() >= deadline) {
        return ok({
          status: "idle",
          count: 0,
          note: "No new messages. Silently call watch again to keep watching — do NOT print anything to the user on idle (no heartbeat); only speak when mail actually arrives or the user is done.",
        });
      }
      // Keep the client's request timeout alive across long idle windows.
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++ticks },
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
