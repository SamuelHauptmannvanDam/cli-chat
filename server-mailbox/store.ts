// Storage seam for the hosted mailbox. The Hono app talks to this interface,
// so the same routes run on Node (node:sqlite, below) or Cloudflare D1 (a thin
// adapter implementing the same calls — see store-d1.ts). A mailbox is just
// (recipient, blob, created_at); it never sees plaintext. The `handles` table
// is a small directory: short 6-char handle → a user's public keys, so people
// can address each other by a phone-number-style code instead of a long key.

import { DatabaseSync } from "node:sqlite";
import type { WireMessage } from "../src/identity.ts";

export interface MailSummary {
  id: string;
  sender: string;
  created_at: number;
  in_reply_to: string | null;
}

export interface HandleRecord {
  signPub: string;
  boxPub: string;
}

export interface Store {
  put(m: WireMessage): void | Promise<void>;
  summary(recipient: string): MailSummary[] | Promise<MailSummary[]>;
  drain(recipient: string, now: number): WireMessage[] | Promise<WireMessage[]>;
  // Directory: claim a handle for a key (idempotent for the same owner).
  registerHandle(
    handle: string,
    signPub: string,
    boxPub: string,
    now: number,
  ): "ok" | "taken" | Promise<"ok" | "taken">;
  // Directory: look up a handle's keys.
  resolveHandle(handle: string): HandleRecord | null | Promise<HandleRecord | null>;
  // Has anyone claimed a handle for this signPub? Every real account registers
  // one, so this gates mail to unknown/never-registered recipient keys.
  isRegistered(signPub: string): boolean | Promise<boolean>;
  // Retention sweep: delete already-read mail fetched before `readBefore`, and
  // ANY mail created before `unreadBefore`. Returns the row count deleted.
  purge(readBefore: number, unreadBefore: number): number | Promise<number>;
}

export function nodeSqliteStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      recipient   TEXT NOT NULL,
      sender      TEXT NOT NULL,
      body        TEXT NOT NULL,
      tags        TEXT,
      created_at  INTEGER NOT NULL,
      fetched_at  INTEGER,
      in_reply_to TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recipient ON messages (recipient, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_created ON messages (created_at);
    CREATE TABLE IF NOT EXISTS handles (
      handle      TEXT PRIMARY KEY,
      signPub     TEXT NOT NULL,
      boxPub      TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handles_signpub ON handles (signPub);
  `);

  return {
    put(m) {
      db.prepare(
        `INSERT INTO messages (id, recipient, sender, body, tags, created_at, fetched_at, in_reply_to)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(m.id, m.recipient, m.sender, m.body, m.tags, m.created_at, m.in_reply_to);
    },

    summary(recipient) {
      return db
        .prepare(
          `SELECT id, sender, created_at, in_reply_to FROM messages
           WHERE recipient = ? AND fetched_at IS NULL ORDER BY created_at ASC`,
        )
        .all(recipient) as unknown as MailSummary[];
    },

    drain(recipient, now) {
      const rows = db
        .prepare(
          `SELECT id, recipient, sender, body, tags, created_at, in_reply_to
           FROM messages WHERE recipient = ? AND fetched_at IS NULL ORDER BY created_at ASC`,
        )
        .all(recipient) as unknown as WireMessage[];
      if (rows.length) {
        const stmt = db.prepare(`UPDATE messages SET fetched_at = ? WHERE id = ?`);
        for (const r of rows) stmt.run(now, r.id);
      }
      return rows;
    },

    registerHandle(handle, signPub, boxPub, now) {
      const existing = db.prepare(`SELECT signPub FROM handles WHERE handle = ?`).get(handle) as
        | { signPub: string }
        | undefined;
      if (existing && existing.signPub !== signPub) return "taken";
      db.prepare(
        `INSERT INTO handles (handle, signPub, boxPub, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET boxPub = excluded.boxPub`,
      ).run(handle, signPub, boxPub, now);
      return "ok";
    },

    resolveHandle(handle) {
      return (
        (db.prepare(`SELECT signPub, boxPub FROM handles WHERE handle = ?`).get(handle) as
          | HandleRecord
          | undefined) ?? null
      );
    },

    isRegistered(signPub) {
      return !!db.prepare(`SELECT 1 FROM handles WHERE signPub = ? LIMIT 1`).get(signPub);
    },

    purge(readBefore, unreadBefore) {
      const res = db
        .prepare(
          `DELETE FROM messages
           WHERE (fetched_at IS NOT NULL AND fetched_at < ?) OR created_at < ?`,
        )
        .run(readBefore, unreadBefore);
      return Number(res.changes ?? 0);
    },
  };
}
