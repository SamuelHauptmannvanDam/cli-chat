// The A1 "live inbox" listener. A short-lived, BLOCKING process the agent runs in
// the BACKGROUND when the user says "listen": it waits until new mail lands,
// prints the whole waiting batch as one JSON line, and EXITS 0. The agent's
// harness re-invokes it on that exit — so the agent renders the batch into the
// live feed and relaunches this command. No held-open tool call (unlike `watch`),
// and no model cost while idle: between messages this is just a sleeping process.
//
// Two modes, chosen by the listener's own env (the start_listening tool passes a
// matching MESSENGER_PUSH):
//   - push (default): the MCP server's warmer keeps a decrypted pending.json
//     current from the push socket. We only WATCH that file — never open inbox.db
//     (avoids the wasm cross-process two-writer hazard) — and ack surfaced ids so
//     they don't resurface on relaunch.
//   - poll (MESSENGER_PUSH=0): no warmer, so we drain the mailbox ourselves.
//
// Unlike `watch`, surfaced mail is NOT read one-at-a-time: the whole batch is
// emitted at once and lives in the agent's context for batch reply.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { currentUser } from "./current-user.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts, senderLabel } from "./contacts.ts";
import { openMailbox, unreadFor, markRead } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { initCrypto } from "./crypto.ts";
import { resolveMailboxUrl } from "./config.ts";
import {
  readPending,
  readAck,
  writePendingAck,
  sync,
  type NetContext,
  type InboxMessage,
} from "./core-net.ts";
import {
  identityFile,
  contactsFile,
  inboxFile,
  pendingFile,
  pendingAckFile,
} from "./paths.ts";

const PENDING_STALE_MS = 120_000; // matches check-inbox: older snapshot → warmer dead
const PUSH_POLL_MS = 1_000; // pending.json watch cadence (local stat — cheap)
const DRAIN_POLL_MS = 3_000; // network drain cadence in poll mode (no warmer)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FeedMessage {
  id: string;
  from: string;
  body: string;
  at: number;
}

// The messages in a snapshot the feed hasn't surfaced yet (i.e. not already
// acked). Pure + exported so the selection is unit-testable without the IO.
export function pickUnsurfaced(messages: InboxMessage[], acked: Set<string>): FeedMessage[] {
  return messages
    .filter((m) => !acked.has(m.id))
    .map((m) => ({ id: m.id, from: m.from, body: m.body, at: m.at }));
}

function emit(event: string, messages: FeedMessage[]): void {
  process.stdout.write(JSON.stringify({ event, count: messages.length, messages }) + "\n");
}

// push mode: watch the warmer's pending.json, surface + ack any new mail, exit.
async function runPush(pendingPath: string, ackPath: string): Promise<void> {
  for (;;) {
    try {
      const snap = readPending(pendingPath);
      // Ignore the boot SEED (synced:false) and any stale file (warmer dead).
      const fresh = snap && snap.synced !== false && Date.now() - snap.writtenAt < PENDING_STALE_MS;
      if (fresh) {
        const newMsgs = pickUnsurfaced(snap!.messages, new Set(readAck(ackPath)));
        if (newMsgs.length) {
          emit("mail", newMsgs);
          // Ack the whole pending set so the warmer marks it read → it won't
          // resurface when the agent relaunches us a moment later.
          writePendingAck(ackPath, snap!.messages.map((m) => m.id));
          return;
        }
      }
    } catch {
      /* transient read/write hiccup — keep waiting */
    }
    await sleep(PUSH_POLL_MS);
  }
}

// poll mode (no warmer is maintaining pending.json): drain the mailbox ourselves
// until something arrives, then mark it read and exit. No two-writer hazard here
// because MESSENGER_PUSH=0 means no warmer holds inbox.db.
async function runPoll(user: string): Promise<void> {
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
    try {
      await sync(ctx);
      const unread = unreadFor(cache, me.signPub);
      if (unread.length) {
        const msgs = unread.map((m) => ({
          id: m.id,
          from: senderLabel(book, m.sender),
          body: m.body,
          at: m.created_at,
        }));
        emit("mail", msgs);
        for (const m of unread) markRead(cache, m.id, now());
        return;
      }
    } catch {
      /* network blip — retry next tick */
    }
    await sleep(DRAIN_POLL_MS);
  }
}

async function main(): Promise<void> {
  const user = currentUser();
  if (!user) return emit("no_account", []);
  try {
    loadIdentity(identityFile(user));
  } catch {
    return emit("no_account", []);
  }
  if (process.env.MESSENGER_PUSH === "0") await runPoll(user);
  else await runPush(pendingFile(user), pendingAckFile(user));
}

// Run the blocking loop only when invoked directly (so importing the pure helper
// in tests has no side effects).
const isEntry = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`await-mail: ${(e as Error).message}`);
      process.exit(0); // never hard-fail — the agent simply relaunches
    });
}
