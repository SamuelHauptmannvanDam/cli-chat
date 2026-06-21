// Cloudflare D1 adapter for the mailbox Store. Same three operations as the
// node:sqlite adapter, against D1's async prepared-statement API. Used by
// worker.ts at deploy time. Untested locally (needs wrangler/Miniflare) — the
// Node adapter is the dev/test path; this is the production target.

import type { HandleRecord, MailSummary, Store } from "./store.ts";
import type { WireMessage } from "../src/identity.ts";

// Minimal shape of the D1 binding we use.
export interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      all(): Promise<{ results: unknown[] }>;
      first(): Promise<unknown>;
    };
  };
}

export function d1Store(db: D1Like): Store {
  return {
    async put(m: WireMessage, receivedAt: number = m.created_at) {
      await db
        .prepare(
          `INSERT INTO messages (id, recipient, sender, body, tags, created_at, received_at, fetched_at, in_reply_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(m.id, m.recipient, m.sender, m.body, m.tags, m.created_at, receivedAt, m.in_reply_to)
        .run();
      // Directed "known pair": sender → recipient. Exempts the recipient's reply
      // from new-sender throttling, and marks this sender known once they reply.
      await db
        .prepare(`INSERT OR IGNORE INTO known (owner, peer, created_at) VALUES (?, ?, ?)`)
        .bind(m.sender, m.recipient, receivedAt)
        .run();
    },

    async summary(recipient: string): Promise<MailSummary[]> {
      const { results } = await db
        .prepare(
          `SELECT id, sender, created_at, in_reply_to FROM messages
           WHERE recipient = ? AND fetched_at IS NULL ORDER BY created_at ASC`,
        )
        .bind(recipient)
        .all();
      return results as MailSummary[];
    },

    async drain(recipient: string, now: number): Promise<WireMessage[]> {
      const { results } = await db
        .prepare(
          `SELECT id, recipient, sender, body, tags, created_at, in_reply_to FROM messages
           WHERE recipient = ? AND fetched_at IS NULL ORDER BY created_at ASC`,
        )
        .bind(recipient)
        .all();
      const rows = results as WireMessage[];
      for (const r of rows) {
        await db.prepare(`UPDATE messages SET fetched_at = ? WHERE id = ?`).bind(now, r.id).run();
      }
      return rows;
    },

    async registerHandle(handle: string, signPub: string, boxPub: string, now: number) {
      const existing = (await db
        .prepare(`SELECT signPub FROM handles WHERE handle = ?`)
        .bind(handle)
        .first()) as { signPub: string } | null;
      if (existing && existing.signPub !== signPub) return "taken";
      await db
        .prepare(
          `INSERT INTO handles (handle, signPub, boxPub, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(handle) DO UPDATE SET boxPub = excluded.boxPub`,
        )
        .bind(handle, signPub, boxPub, now)
        .run();
      return "ok";
    },

    async resolveHandle(handle: string): Promise<HandleRecord | null> {
      return (await db
        .prepare(`SELECT signPub, boxPub FROM handles WHERE handle = ?`)
        .bind(handle)
        .first()) as HandleRecord | null;
    },

    async isRegistered(signPub: string): Promise<boolean> {
      const row = await db
        .prepare(`SELECT 1 FROM handles WHERE signPub = ? LIMIT 1`)
        .bind(signPub)
        .first();
      return row != null;
    },

    async purge(readBefore: number, unreadBefore: number): Promise<number> {
      const res = (await db
        .prepare(
          `DELETE FROM messages
           WHERE (fetched_at IS NOT NULL AND fetched_at < ?) OR created_at < ?`,
        )
        .bind(readBefore, unreadBefore)
        .run()) as { meta?: { changes?: number } };
      return Number(res?.meta?.changes ?? 0);
    },

    async isKnownSender(recipient: string, sender: string): Promise<boolean> {
      const row = await db
        .prepare(`SELECT 1 AS x FROM known WHERE owner = ? AND peer = ? LIMIT 1`)
        .bind(recipient, sender)
        .first();
      return row != null;
    },

    async countRecentFromPair(recipient: string, sender: string, since: number): Promise<number> {
      const row = (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE recipient = ? AND sender = ? AND received_at >= ?`,
        )
        .bind(recipient, sender, since)
        .first()) as { n?: number } | null;
      return Number(row?.n ?? 0);
    },

    async countRecentUnknown(recipient: string, since: number): Promise<number> {
      const row = (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m
           WHERE m.recipient = ? AND m.received_at >= ?
             AND NOT EXISTS (
               SELECT 1 FROM known k WHERE k.owner = m.recipient AND k.peer = m.sender
             )`,
        )
        .bind(recipient, since)
        .first()) as { n?: number } | null;
      return Number(row?.n ?? 0);
    },
  };
}
