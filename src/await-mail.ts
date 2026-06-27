// The A1 "chat" WAKER. A short-lived, BLOCKING process the agent runs in the
// BACKGROUND when the user says "chat": it waits until there is new mail to
// surface, then EXITS 0 — and that's all. It carries NO output the agent needs to
// read. The harness re-invokes the agent on that exit; the agent then fetches the
// batch via the `chat_batch` MCP tool (a clean, named tool call — no temp-file
// path on screen) and relaunches this waker.
//
// It only DETECTS, never delivers. That split is the whole point: because the
// agent never reads this process's stdout, the machine-room output path stays off
// the screen. Content comes from chat_batch instead. See server-net.ts.
//
// Two modes, chosen by the waker's own env (start_chat passes a matching one):
//   - push (default): the MCP server's warmer keeps pending.json current from the
//     push socket. We only WATCH that file (no inbox.db access) and exit when it
//     shows mail the feed hasn't surfaced yet (i.e. not in the ack file).
//   - poll (MESSENGER_PUSH=0): no warmer, so we drain the mailbox until unread
//     appears. We do NOT mark it read — chat_batch marks it when it delivers.
//
// Heartbeats chat.lock every tick so the check-inbox hook stays silent while chat
// is live (the feed is the sole surfacing path). See check-inbox.ts (reader).

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { currentUser } from "./current-user.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts } from "./contacts.ts";
import { openMailbox, unreadFor } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { initCrypto } from "./crypto.ts";
import { resolveMailboxUrl } from "./config.ts";
import { readPending, readAck, sync, type NetContext, type InboxMessage } from "./core-net.ts";
import {
  identityFile,
  contactsFile,
  inboxFile,
  pendingFile,
  pendingAckFile,
  chatLockFile,
} from "./paths.ts";

const PENDING_STALE_MS = 120_000; // matches check-inbox: older snapshot → warmer dead
const PUSH_POLL_MS = 1_000; // pending.json watch cadence (local stat — cheap)
const DRAIN_POLL_MS = 3_000; // network drain cadence in poll mode (no warmer)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The messages in a snapshot the feed hasn't surfaced yet (i.e. not already
// acked). Pure + exported so the selection stays unit-testable without the IO.
export function pickUnsurfaced(messages: InboxMessage[], acked: Set<string>): InboxMessage[] {
  return messages.filter((m) => !acked.has(m.id));
}

// Heartbeat the chat lock so the session hook knows chat is live and stays silent.
// Bumped every tick; never removed — a clean "stop" or kill just lets it go stale,
// and a relaunch refreshes it well within the hook's freshness window.
function touchLock(lockPath: string): void {
  try {
    writeFileSync(lockPath, String(Date.now()));
  } catch {
    /* best-effort heartbeat */
  }
}

// push mode: watch the warmer's pending.json; exit the moment unsurfaced mail
// appears. Never touches inbox.db. The ack file (written by chat_batch when it
// delivers) is what marks a message surfaced — so after a fetch we keep blocking
// instead of re-firing on mail already in the feed.
async function runPush(pendingPath: string, ackPath: string, lockPath: string): Promise<void> {
  for (;;) {
    touchLock(lockPath);
    try {
      const snap = readPending(pendingPath);
      const fresh = snap && snap.synced !== false && Date.now() - snap.writtenAt < PENDING_STALE_MS;
      if (fresh && pickUnsurfaced(snap!.messages, new Set(readAck(ackPath))).length > 0) return;
    } catch {
      /* transient read hiccup — keep waiting */
    }
    await sleep(PUSH_POLL_MS);
  }
}

// poll mode (no warmer is maintaining pending.json): drain the mailbox ourselves
// until unread appears, then exit. We do NOT mark it read — chat_batch does that
// when it delivers the batch, so the read-state stays single-owner.
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
  };
  for (;;) {
    touchLock(lockPath);
    try {
      await sync(ctx);
      if (unreadFor(cache, me.signPub).length > 0) return;
    } catch {
      /* network blip — retry next tick */
    }
    await sleep(DRAIN_POLL_MS);
  }
}

async function main(): Promise<void> {
  const user = currentUser();
  if (!user) return; // no account → exit; chat_batch reports the real state
  try {
    loadIdentity(identityFile(user));
  } catch {
    return;
  }
  const lockPath = chatLockFile(user);
  if (process.env.MESSENGER_PUSH === "0") await runPoll(user, lockPath);
  else await runPush(pendingFile(user), pendingAckFile(user), lockPath);
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
