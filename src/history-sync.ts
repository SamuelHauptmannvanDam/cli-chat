// Message-history sync (AUTH-SYNC.md): every message this device sends or
// receives is queued in a local JSONL outbox, periodically sealed into an
// encrypted chunk and appended to the account's server-side history stream; a
// cursor pull brings back what OTHER devices appended. Together the devices
// converge on one complete history while every read stays local (HISTORY.md).
//
// Ordering rules that keep this simple:
//   - chunks are append-only with a per-account monotonic seq → pull is a cursor;
//   - message ids are globally unique and inserts are OR IGNORE → re-pulling our
//     own chunks (or a re-seeded overlap) dedups for free;
//   - pulled rows land BORN READ. Live "new mail" surfacing belongs to the device
//     that drained the mailbox; syncing read-state across devices is future work.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AccountClient } from "./core/account-client.ts";
import { decryptBlob, encryptBlob } from "./blob-crypto.ts";
import { insertMessage, type Mailbox, type MessageRow } from "./db.ts";
import { historyOutboxFile } from "./paths.ts";
import { loadSession, setHistoryCursor } from "./session.ts";
import { writeSecret } from "./secure-fs.ts";

// Rows per encrypted chunk. Bounded so a chunk stays far below the server's
// per-blob cap even with long bodies (16KB max sealed body / message).
const CHUNK_ROWS = 200;

interface HistoryChunkBlob {
  v: 1;
  rows: MessageRow[];
}

// Queue one message for the next history push. Best-effort by contract: history
// must never break a send or a drain.
export function appendOutbox(user: string, row: MessageRow): void {
  try {
    const path = historyOutboxFile(user);
    if (!existsSync(path)) writeSecret(path, ""); // create 0600 before appending
    appendFileSync(path, JSON.stringify(row) + "\n");
  } catch {
    /* the seed/backfill path re-covers anything missed */
  }
}

function readOutbox(user: string): MessageRow[] {
  const path = historyOutboxFile(user);
  if (!existsSync(path)) return [];
  const rows: MessageRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as MessageRow);
    } catch {
      /* torn line (crash mid-append) — drop it; the message is still in the cache */
    }
  }
  return rows;
}

// Remove the first `count` rows (the ones just pushed), preserving anything a
// concurrent send appended while the push was in flight.
function dropPushed(user: string, count: number): void {
  const rows = readOutbox(user);
  const rest = rows.slice(count);
  writeFileSync(historyOutboxFile(user), rest.map((r) => JSON.stringify(r)).join("\n") + (rest.length ? "\n" : ""));
}

// First-sync backfill: queue the device's ENTIRE local cache so pre-existing
// conversations reach the account too. Runs at most once — only when this device
// has never pulled (no cursor) and never queued (no outbox file). Overlap with
// what another device already uploaded is deduped on pull by message id.
function seedOutboxFromCache(user: string, cache: Mailbox, meSignPub: string): number {
  if (existsSync(historyOutboxFile(user))) return 0;
  if (loadSession(user)?.historyCursor != null) return 0;
  const rows = cache.all(
    `SELECT * FROM messages WHERE recipient = ? OR sender = ? ORDER BY created_at ASC`,
    [meSignPub, meSignPub],
  ) as unknown as MessageRow[];
  writeSecret(historyOutboxFile(user), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return rows.length;
}

export type HistorySyncOutcome =
  | { ok: true; pushed: number; pulled: number; cursor: number }
  | { ok: false; reason: "unauthorized" | "payment_required" | "no_data_key" | "network"; note?: string };

// One full round-trip: push the outbox up as encrypted chunks, then pull + apply
// everything past this device's cursor. Requires the account data key — history
// is never pushed plaintext. When `meSignPub` is given, a first-ever sync seeds
// the outbox from the whole local cache (see seedOutboxFromCache).
export async function syncHistory(
  client: AccountClient,
  token: string,
  user: string,
  dataKey: string | undefined,
  cache: Mailbox,
  meSignPub?: string,
): Promise<HistorySyncOutcome> {
  if (!dataKey) return { ok: false, reason: "no_data_key" };
  if (meSignPub) {
    try {
      seedOutboxFromCache(user, cache, meSignPub);
    } catch {
      /* cache hiccup — the outbox hook still covers new messages */
    }
  }

  let pushed = 0;
  try {
    for (;;) {
      const rows = readOutbox(user);
      if (!rows.length) break;
      const batch = rows.slice(0, CHUNK_ROWS);
      const blob = encryptBlob(JSON.stringify({ v: 1, rows: batch } satisfies HistoryChunkBlob), dataKey);
      const res = await client.pushHistory(token, [blob]);
      if (res === "unauthorized") return { ok: false, reason: "unauthorized" };
      if (res === "payment_required") return { ok: false, reason: "payment_required" };
      dropPushed(user, batch.length);
      pushed += batch.length;
    }
  } catch (e) {
    return { ok: false, reason: "network", note: (e as Error).message };
  }

  let pulled = 0;
  let cursor = loadSession(user)?.historyCursor ?? 0;
  try {
    for (;;) {
      const page = await client.pullHistory(token, cursor);
      if (page === "unauthorized") return { ok: false, reason: "unauthorized" };
      if (page === "payment_required") return { ok: false, reason: "payment_required" };
      for (const chunk of page.chunks) {
        try {
          const plain = decryptBlob(chunk.blob, dataKey);
          const parsed = JSON.parse(plain) as HistoryChunkBlob;
          for (const row of parsed.rows ?? []) {
            if (!row?.id) continue;
            insertMessage(cache, {
              ...row,
              // Born read: history arriving from another device is recall
              // material, not new mail — it must never trip the inbox hooks.
              fetched_at: row.fetched_at ?? row.created_at,
              read_at: row.read_at ?? row.created_at,
            });
            pulled++;
          }
        } catch {
          // Undecryptable/malformed chunk (key rotation, corruption): skip it
          // rather than wedging the cursor forever.
        }
        cursor = Math.max(cursor, chunk.seq);
      }
      setHistoryCursor(user, cursor);
      if (!page.chunks.length || cursor >= page.last) break;
    }
  } catch (e) {
    return { ok: false, reason: "network", note: (e as Error).message };
  }

  return { ok: true, pushed, pulled, cursor };
}
