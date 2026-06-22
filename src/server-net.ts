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
import { userInfo } from "node:os";
import { initCrypto, generateIdentity } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts, saveContacts, orderedContacts } from "./contacts.ts";
import { openMailbox } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { encodeKey } from "./key-code.ts";
import { currentUser, setCurrentUser, resolveIdentity } from "./current-user.ts";
import {
  userDir as userDirOf,
  identityFile,
  contactsFile,
  inboxFile,
  pendingFile,
  pendingAckFile,
} from "./paths.ts";
import { resolveMailboxUrl } from "./config.ts";
import { startWarmer } from "./warmer.ts";
import { claimHandle } from "./provision.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import {
  addContact,
  deleteContact,
  draftReply,
  messagesAvailable,
  readMessage,
  sendMessage,
  sync,
  takeUnread,
  type NetContext,
} from "./core-net.ts";

const mailboxUrl = resolveMailboxUrl();
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long a single `watch` long-poll blocks before returning `idle`. The MCP
// client (Claude Code) normally aborts a tool call after ~60s, but we emit a
// progress notification on every inner tick (see WATCH_PING_MS) — clients that
// honor MCP progress reset their timeout on each one, so the call can safely
// outlive 60s. While watch blocks, the agent can't process the user's next
// message (incl. "stop") until it returns, but an aborted call returns at once.
//
// Override with MESSENGER_WATCH_MS. We parse defensively: an unset, empty, or
// non-numeric value (e.g. a Windows shell that doesn't expand the "${VAR:-…}"
// default form in .mcp.json) falls back to DEFAULT_WATCH_MS instead of silently
// becoming 0/NaN — the bug behind "watch re-fires every ~minute" on Windows.
const DEFAULT_WATCH_MS = 550_000; // ~9.2 min
const parsedWatchMs = Number(process.env.MESSENGER_WATCH_MS);
const WATCH_MS = Number.isFinite(parsedWatchMs) && parsedWatchMs > 0 ? parsedWatchMs : DEFAULT_WATCH_MS;
// How often the watch loop wakes to re-check the local cache, send the client
// keepalive ping, and (every WATCH_SYNC_MS) re-drain the mailbox as a network
// backstop for when push (the warmer WebSocket) is off or blocked.
const WATCH_PING_MS = 3_000;
const WATCH_SYNC_MS = 15_000;
// Floor for a caller-requested adaptive hold (see the watch tool's `hold_seconds`).
// WATCH_MS stays the ceiling: a caller can ask for a SHORTER hold to stay
// responsive while the user is actively chatting, never a longer one.
const WATCH_MIN_MS = 2_000;

await initCrypto();

// A resolved identity + everything bound to it. Built lazily so the server can
// start with no account and create one on demand (create_account).
function buildSession(user: string) {
  const contactsPath = contactsFile(user);
  const me = loadIdentity(identityFile(user));
  const book = loadContacts(contactsPath);
  // The inbox cache is best-effort: NEVER let an open failure collapse the
  // session. openMailbox now defers the actual file open (per-op on wasm, or a
  // shareable WAL handle on native — see db.ts), so cross-process contention no
  // longer throws here the way the old persistent wasm handle did (which used to
  // surface as a false `no_account` and mint a DUPLICATE identity). The try/catch
  // stays as cheap defence: on any unexpected open error, fall back to a
  // temporary in-memory cache so the session still loads and reports the real code.
  let cache;
  try {
    cache = openMailbox(inboxFile(user));
  } catch (e) {
    console.error(
      `Inbox cache for "${user}" is unavailable (${(e as Error).message}); ` +
        `using a temporary in-memory cache for this session.`,
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
  if (S)
    stopWarmer = startWarmer(S.ctx, {
      mailboxUrl,
      now,
      pendingPath: pendingFile(S.user),
      ackPath: pendingAckFile(S.user),
    });
}
ensureWarmer();

// Behavior travels WITH the server (MCP `instructions`, sent on connect) so it
// works in any MCP-capable CLI — not just Claude Code's CLAUDE.md. The text is
// the single source in ./instructions.ts; esbuild inlines it into the bundle.
const server = new McpServer({ name: "cli-chat", version: "0.4.11" }, { instructions: INSTRUCTIONS });
const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
// Returned by any identity-requiring tool when no account exists yet.
const noAccount = () =>
  ok({
    ok: false,
    reason: "no_account",
    note:
      "No account on this device yet. Call create_account to generate your identity " +
      "and 6-char code. Ask the user for their full name first; only fall back to the " +
      "OS login name if they don't give one.",
  });

type Session = NonNullable<typeof S>;

// Every tool except create_account needs an established account. `guard` makes
// that check uniform: the wrapped handler only runs when a session exists (and
// receives it as its first arg), otherwise the standard no_account result is
// returned. Handlers return plain data — guard JSON-wraps it with `ok`.
const guard =
  (handler: (s: Session, args: any, extra: any) => unknown) =>
  async (args: any, extra: any) =>
    S ? ok(await handler(S, args, extra)) : noAccount();

server.registerTool(
  "create_account",
  {
    title: "Create your account / set your display name",
    description:
      "Set up the USER'S OWN identity on this device: generate their keypair " +
      "(private keys never leave the machine), claim a short 6-character code " +
      "(their 'number') in the registry, and return it to share. Use when the " +
      "user wants to get set up / join / get their code, or when another tool " +
      "reported `no_account`. Their `name` travels with every message they send " +
      "(it's what recipients see, and how mutual contacts find them), so set a " +
      "real one: ask for their full name (\"what's your full name?\") if you " +
      "don't know it. Idempotent and doubles as a renamer — if they " +
      "already have an account, calling it returns their existing code, and " +
      "passing `name` UPDATES their display name (use for 'call me X'). (This is " +
      "for the user themselves — to save OTHER people, use add_contact.)",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          "The user's own display name — ideally their FULL name, e.g. 'Lars " +
            "Andersen' — what people see when they message, and how mutual " +
            "contacts find them. On an existing account this updates it. Defaults " +
            "to the OS login name only if you can't get a real one.",
        ),
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
    saveContacts(contactsFile(id.handle), { me: id.signPub, contacts: [] });
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

// Account-requiring tools that are pure delegations (or small data shaping) over
// the session. Listed as a table so registration is a single uniform loop —
// every entry gets the same `guard` (no_account) wrapper, and the handler just
// returns plain data. The two genuinely special tools live outside this table:
// `create_account` (the only one that runs WITHOUT an account) and `watch` (a
// long-poll loop that needs the request's `extra`), registered below.
const TOOLS: {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  run: (s: Session, args: any) => unknown;
}[] = [
  {
    name: "send_message",
    title: "Send an encrypted message by name or key",
    description:
      "Seal a message and post it to the hosted mailbox. Normally pass `to` = a " +
      "known contact name; matching is partial, so a short name like 'Niels' " +
      "resolves a saved 'Niels - bankdata'. Anyone who has ALREADY messaged the " +
      "user is auto-saved, so you can usually just use their name — no code " +
      "needed. Only supply `key` for someone BRAND new who hasn't messaged first: " +
      "the user gives their 6-char handle or long key code; pass it as `key` with " +
      "their name in `to`, and they'll be saved so next time the name alone works. " +
      "Returns the resolved contact; `no_contact` means nothing matched (offer to " +
      "add by code), `ambiguous` returns the candidates to disambiguate.",
    inputSchema: {
      to: z.string().describe("Contact name, e.g. 'Sam'"),
      body: z.string().describe("The message text (encrypted end-to-end)"),
      key: z
        .string()
        .optional()
        .describe("6-char handle or long key code for a NEW person; saves them under `to`"),
    },
    run: (s, { to, body, key }) => sendMessage(s.ctx, { to, body, key }),
  },
  {
    name: "add_contact",
    title: "Save or rename a contact",
    description:
      "Remember a person by name from the key code they shared, so the user can " +
      "later just say 'write <name>'. Use when the user says something like " +
      "'add my mate Sam, his key is …'. Upserts by key, not name: saving a name " +
      "against a key that's already on file REPLACES the old entry (no duplicate), " +
      "which is also how a rename works — pass the existing `fullKey` with the new " +
      "name. (The rename flow and how nicknames are used on screen are in the " +
      "server instructions.)",
    inputSchema: {
      name: z.string().describe("Your nickname for them, e.g. 'Sam'"),
      key: z
        .string()
        .describe("Their 6-char handle, or a long full key code (letters and numbers)"),
    },
    run: (s, { name, key }) => addContact(s.ctx, { name, key }),
  },
  {
    name: "delete_contact",
    title: "Delete a saved contact",
    description:
      "Remove a person from the address book by name. Use when the user says " +
      "'delete Niels', 'remove Sam from my contacts', or 'forget this person'. " +
      "Name matching is partial, like send_message: a short name resolves a " +
      "saved 'Niels - bankdata'. Returns the deleted name on success; " +
      "`no_contact` means nothing matched, `ambiguous` returns the candidate " +
      "names so you can ask which one rather than guessing. Deleting only forgets " +
      "them locally — it doesn't block them, and they can be re-added from their " +
      "code later.",
    inputSchema: {
      name: z.string().describe("Contact name to delete, e.g. 'Niels'"),
    },
    run: (s, { name }) => deleteContact(s.ctx, { name }),
  },
  {
    name: "my_key",
    title: "Show my own code to share",
    description:
      "Return the user's own short handle (a 6-character code) to hand to anyone " +
      "who wants to message them. Use when the user asks 'what's my " +
      "key/number/handle/invite?'.",
    inputSchema: {},
    run: (s) => ({
      name: s.me.name ?? s.user,
      handle: s.me.handle ?? null,
      note: s.me.handle ? undefined : "No handle yet — call create_account to claim one.",
      fullKey: encodeKey(s.me.signPub, s.me.boxPub),
    }),
  },
  {
    name: "contacts",
    title: "List my contacts (me first, then saved people)",
    description:
      "Return the user's own entry (`me`: their display name, 6-char handle, and " +
      "shareable full key) followed by everyone they've saved — each with the " +
      "nickname to address them by, any aliases, their 6-char handle (when known), " +
      "and their full key. ALWAYS show the user's own entry FIRST so they can see " +
      "their own name + handle at a glance (and update the name with create_account " +
      "if it's wrong). Use when the user asks 'who are my contacts?', 'show my " +
      "address book', or 'what's my name/handle?'. Saved people come back in two " +
      "lists: `active` (written in the last 60 days, ordered by who the user " +
      "messages most) and `contacts` (everyone else, alphabetical). Render `active` " +
      "first when non-empty, then `contacts` A–Z; do NOT show message counts.",
    inputSchema: {},
    run: (s) => {
      const fmt = (c: (typeof s.book.contacts)[number]) => ({
        name: c.name,
        aliases: c.aliases ?? [],
        handle: c.handle ?? null,
        fullKey: c.signPub && c.boxPub ? encodeKey(c.signPub, c.boxPub) : null,
      });
      // active = written in the last 60 days, most-written first; rest = everyone
      // else, alphabetical. A contact you stop messaging ages out of active on its
      // own. Render active first, then rest A–Z; do NOT show message counts.
      const { active, rest } = orderedContacts(s.book.contacts, s.ctx.now());
      return {
        me: {
          self: true,
          name: s.me.name ?? s.user,
          handle: s.me.handle ?? null,
          fullKey: encodeKey(s.me.signPub, s.me.boxPub),
        },
        count: s.book.contacts.length,
        active: active.map(fmt),
        contacts: rest.map(fmt),
      };
    },
  },
  {
    name: "messages_available",
    title: "Check for waiting messages",
    description:
      "Proactive inbox signal. Pulls and decrypts any new mail, then returns the " +
      "count and previews of unread messages. Each `from` is the user's nickname " +
      "for the sender, or 'Name (handle)' for someone new (who is auto-saved on " +
      "arrival). Call this when the CLI opens.",
    inputSchema: {},
    run: (s) => messagesAvailable(s.ctx),
  },
  {
    name: "read_message",
    title: "Read a waiting message",
    description:
      "Read a decrypted message by id (or oldest unread). Marks it read. `from` is " +
      "the user's nickname for the sender, or 'Name (handle)' for someone new.",
    inputSchema: { id: z.string().optional().describe("Message id; omit for oldest unread") },
    run: (s, { id }) => readMessage(s.ctx, { id }),
  },
  {
    name: "draft_reply",
    title: "Send an encrypted reply",
    description:
      "Reply to a message, sealed and threaded. Works even if the sender wasn't a " +
      "saved contact — their message carried a reply key, so they were auto-saved " +
      "and can be answered directly. Draft it yourself; if it needs a fact you " +
      "lack (the human's availability, a decision), ask the human first. " +
      "(`no_keys` only happens for legacy messages sent without a reply key.)",
    inputSchema: {
      in_reply_to: z.string().describe("Id of the message being replied to"),
      body: z.string().describe("The reply text"),
    },
    run: (s, { in_reply_to, body }) => draftReply(s.ctx, { in_reply_to, body }),
  },
];

// Just-in-time choreography attached to tool RESULTS. Unlike the server
// `instructions` field (which some MCP clients silently drop), a result note
// rides along with the tool output every client hands back to the model — so the
// few highest-value behaviors survive even where server instructions don't. Keep
// these terse; the full policy still lives in instructions.ts. Never overrides a
// note the handler already set.
const resultNote = (name: string, r: any): string | undefined => {
  switch (name) {
    case "send_message":
      if (r.ok) return "Sent. Tell the user in one line what you sent — don't ask to confirm.";
      if (r.reason === "no_contact") return "No contact matched. Offer to add them with their 6-char code.";
      if (r.reason === "ambiguous") return "Several matched: name the candidates and ask the user which — don't guess.";
      return undefined;
    case "delete_contact":
      if (r.ok) return "Confirm in one line, e.g. 'Deleted Niels.'";
      return undefined;
    case "read_message":
      if (r.ok) return "Read this out to the user (sender + body); to reply, use draft_reply with this id.";
      return undefined;
    case "draft_reply":
      if (r.ok) return "Confirm in one line what you sent.";
      return undefined;
    case "contacts":
      return "Show the user's own entry (me) first, then list the saved contacts.";
    default:
      return undefined;
  }
};

const attachNote = (name: string, r: any): any => {
  if (!r || typeof r !== "object" || Array.isArray(r) || r.note) return r;
  const note = resultNote(name, r);
  return note ? { ...r, note } : r;
};

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    { title: t.title, description: t.description, inputSchema: t.inputSchema },
    guard(async (s, args) => attachNote(t.name, await t.run(s, args))),
  );
}

server.registerTool(
  "watch",
  {
    title: "Watch for incoming messages (adaptive long-poll loop)",
    description:
      "Block up to `hold_seconds` waiting for new mail, then return it (already " +
      "marked read) or report idle if none arrived. The building block of a watch " +
      "loop: call it again after each return to keep watching. Each returned " +
      "`from` is the user's nickname for the sender, or 'Name (handle)' for " +
      "someone new (auto-saved on arrival, so you can reply by name). Use when the " +
      "user asks to watch for / wait for / keep an eye out for messages. (How to " +
      "pace the loop — adaptive hold, backing off when idle, reading mail out in " +
      "full — is in the server instructions.)",
    inputSchema: {
      hold_seconds: z
        .number()
        .optional()
        .describe(
          "How long THIS call blocks before returning idle. Use ~5 while the user " +
            "is actively chatting (responsive), backing off (15/30/60…) when idle. " +
            "Clamped to [2s, server max]; omit for the long default.",
        ),
    },
  },
  guard(async (s, { hold_seconds }, extra) => {
    const requestedMs = Number(hold_seconds) * 1000;
    const holdMs =
      Number.isFinite(requestedMs) && requestedMs > 0
        ? Math.min(Math.max(requestedMs, WATCH_MIN_MS), WATCH_MS)
        : WATCH_MS;
    const deadline = now() + holdMs;
    const progressToken = extra?._meta?.progressToken;
    let ticks = 0;
    // The background warmer (PUSH.md) drains new mail into the cache via push, so
    // each tick just reads the LOCAL cache (cheap, no network). As a backstop for
    // when push is off/unavailable (MESSENGER_PUSH=0, or the WebSocket is blocked
    // by a firewall/proxy — common on Windows), we ALSO re-drain the mailbox over
    // the network every WATCH_SYNC_MS so mail still surfaces within a single call.
    await sync(s.ctx); // initial catch-up
    let sinceSync = 0;
    for (;;) {
      if (extra?.signal?.aborted) return { status: "idle", count: 0, note: "Watch cancelled." };
      const messages = takeUnread(s.ctx);
      if (messages.length > 0) {
        return {
          status: "messages",
          count: messages.length,
          messages,
          note: "Read these out in full (sender + body) and offer to reply (draft_reply). Call watch again to keep watching.",
        };
      }
      if (now() >= deadline) {
        return {
          status: "idle",
          count: 0,
          note: "No new messages. Silently call watch again to keep watching — do NOT print anything to the user on idle (no heartbeat); only speak when mail actually arrives or the user is done. If the user has been quiet, raise hold_seconds (e.g. 15/30/60) to stay cheap; drop back to ~5 the instant they type or mail lands.",
        };
      }
      // Keep the client's request timeout alive across long idle windows.
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: ++ticks },
        });
      }
      await sleep(WATCH_PING_MS);
      // Network backstop: when push didn't deliver (warmer off or socket blocked),
      // re-drain the mailbox periodically so mail surfaces within THIS call instead
      // of only on the next re-invocation. The next loop turn reads it from cache.
      sinceSync += WATCH_PING_MS;
      if (sinceSync >= WATCH_SYNC_MS) {
        sinceSync = 0;
        await sync(s.ctx);
      }
    }
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  S
    ? `cli-chat (Phase 1) up as "${S.user}" → mailbox ${mailboxUrl}`
    : `cli-chat (Phase 1) up with NO account → mailbox ${mailboxUrl} (call create_account)`,
);
