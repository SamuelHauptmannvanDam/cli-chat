// The A1 "chat" WAKER. A short-lived, BLOCKING process the agent runs in the
// BACKGROUND when the user says "chat": it waits until there is new mail to
// surface, then EXITS 0 — and that's all. It carries NO output the agent needs to
// read. The harness re-invokes the agent on that exit; the agent then fetches the
// batch via the `read_messages` MCP tool (a clean, named tool call — no temp-file
// path on screen) and relaunches this waker.
//
// It only DETECTS, never delivers. That split is the whole point: because the
// agent never reads this process's stdout, the machine-room output path stays off
// the screen. Content comes from read_messages instead. See server-net.ts.
//
// Two modes, chosen by the waker's own env (the chat tools pass a matching one):
//   - push (default): the MCP server's warmer keeps pending.json current from the
//     push socket. We only WATCH that file (no inbox.db access) and exit when it
//     shows mail the feed hasn't surfaced yet (i.e. not in the ack file).
//   - poll (MESSENGER_PUSH=0): no warmer, so we drain the mailbox until unread
//     appears. We do NOT mark it read — read_messages marks it when it delivers.
//
// Heartbeats chat.lock every tick so the rest of the system knows chat is live
// (the inbox rider goes quiet — the feed is the sole surfacing path — and a
// public session's gate bypass applies). See core-net readChatLock (reader).

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { currentUser } from "./current-user.ts";
import { loadSession, markVaultDirty } from "./session.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts } from "./contacts.ts";
import { openMailbox, unreadFor } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { initCrypto } from "./crypto.ts";
import { resolveMailboxUrl } from "./config.ts";
import { readPending, readAck, readIdList, sync, type NetContext, type InboxMessage } from "./core-net.ts";
import { contactByKey } from "./contacts.ts";
import {
  identityFile,
  contactsFile,
  inboxFile,
  pendingFile,
  pendingAckFile,
  gatedNotifiedFile,
  chatLockFile,
  threadsDir,
} from "./paths.ts";

const PENDING_STALE_MS = 120_000; // older snapshot → warmer dead
const PUSH_POLL_MS = 1_000; // pending.json watch cadence (local stat — cheap)
const DRAIN_POLL_MS = 3_000; // network drain cadence in poll mode (no warmer)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The messages in a snapshot the feed hasn't surfaced yet (i.e. not already
// acked). Pure + exported so the selection stays unit-testable without the IO.
export function pickUnsurfaced(messages: InboxMessage[], acked: Set<string>): InboxMessage[] {
  return messages.filter((m) => !acked.has(m.id));
}

// Heartbeat the chat lock so the rest of the system knows chat is live. Bumped
// every tick; never removed — a clean "stop" or kill just lets it go stale, and
// a relaunch refreshes it well within readChatLock's freshness window.
// Public chat (0.18, the new-handle gate's per-session bypass): the chat tools
// set MESSENGER_CHAT_PUBLIC=1 when the user asked for the public variant. It
// rides in the lock so every process (the warmer's sync, chatBatch) sees that a
// public session is live and lets new handles straight through.
const chatPublic = process.env.MESSENGER_CHAT_PUBLIC === "1";
// Foreground harnesses (no background-task support) prefix MESSENGER_WAIT_MAX=<s>
// so the wait exits empty-handed before their tool timeout would kill it — the
// agent just relaunches. Unset/0 = block until mail (the background default).
const waitMaxMs = (Number(process.env.MESSENGER_WAIT_MAX) || 0) * 1000;
const waitDeadline = waitMaxMs > 0 ? Date.now() + waitMaxMs : Infinity;
function touchLock(lockPath: string): void {
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ at: Date.now(), ...(chatPublic ? { public: true } : {}) }),
    );
  } catch {
    /* best-effort heartbeat */
  }
}

// push mode: watch the warmer's pending.json; exit the moment unsurfaced mail
// appears. Never touches inbox.db. The ack file (written by read_messages when it
// delivers) is what marks a message surfaced — so after a fetch we keep blocking
// instead of re-firing on mail already in the feed. A GATED arrival (a new
// handle's held message) also wakes — the feed renders it as a name+handle
// summary card — but only until read_messages records it in gated-notified.json.
async function runPush(
  pendingPath: string,
  ackPath: string,
  gatedNotifiedPath: string,
  lockPath: string,
): Promise<void> {
  for (;;) {
    touchLock(lockPath);
    try {
      const snap = readPending(pendingPath);
      const fresh = snap && snap.synced !== false && Date.now() - snap.writtenAt < PENDING_STALE_MS;
      if (fresh) {
        if (pickUnsurfaced(snap!.messages, new Set(readAck(ackPath))).length > 0) return;
        const notified = new Set(readIdList(gatedNotifiedPath));
        if ((snap!.gated ?? []).some((m) => !notified.has(m.id))) return;
      }
    } catch {
      /* transient read hiccup — keep waiting */
    }
    if (Date.now() >= waitDeadline) return; // bounded wait (foreground harnesses)
    await sleep(PUSH_POLL_MS);
  }
}

// poll mode (no warmer is maintaining pending.json): drain the mailbox ourselves
// until unread appears, then exit. We do NOT mark it read — read_messages does that
// when it delivers the batch, so the read-state stays single-owner. Gated rows
// (held new handles) don't count as "unread appeared" once the feed has been
// notified of them — otherwise a held message would re-fire the waker forever.
async function runPoll(user: string, lockPath: string): Promise<void> {
  await initCrypto();
  const me = loadIdentity(identityFile(user));
  const book = loadContacts(contactsFile(user));
  const cache = openMailbox(inboxFile(user));
  const now = () => Date.now();
  const ctx: NetContext = {
    me,
    book,
    cache,
    client: createMailboxClient(resolveMailboxUrl(), me, now),
    now,
    contactsPath: contactsFile(user),
    threadsPath: threadsDir(user),
    // This waker IS the live chat session, so its own public flag is the truth —
    // no lock round-trip needed. Public → new senders flow in ungated.
    allowNewSenders: () => chatPublic,
    // A sender auto-saved during a poll-mode drain must reach the vault too.
    onBookChange: () => {
      try {
        if (loadSession(user)) markVaultDirty(user);
      } catch {
        /* best-effort */
      }
    },
  };
  const gatedNotifiedPath = gatedNotifiedFile(user);
  for (;;) {
    touchLock(lockPath);
    try {
      await sync(ctx);
      const rows = unreadFor(cache, me.signPub);
      const gate = (sender: string) =>
        sender === me.signPub ? undefined : contactByKey(book, sender)?.gated;
      if (rows.some((m) => !gate(m.sender))) return;
      const notified = new Set(readIdList(gatedNotifiedPath));
      if (rows.some((m) => gate(m.sender) === "pending" && !notified.has(m.id))) return;
    } catch {
      /* network blip — retry next tick */
    }
    if (Date.now() >= waitDeadline) return; // bounded wait (foreground harnesses)
    await sleep(DRAIN_POLL_MS);
  }
}

async function main(): Promise<void> {
  const user = currentUser();
  if (!user) return; // no account → exit; read_messages reports the real state
  try {
    loadIdentity(identityFile(user));
  } catch {
    return;
  }
  const lockPath = chatLockFile(user);
  if (process.env.MESSENGER_PUSH === "0") await runPoll(user, lockPath);
  else await runPush(pendingFile(user), pendingAckFile(user), gatedNotifiedFile(user), lockPath);
}

// Run the blocking loop only when invoked directly (so importing the pure helper
// in tests has no side effects).
const isEntry = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`chat waker: ${(e as Error).message}`);
      process.exit(0); // never hard-fail — the agent simply relaunches
    });
}
