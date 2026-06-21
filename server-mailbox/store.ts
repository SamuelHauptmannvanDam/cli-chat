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
  // `receivedAt` is the SERVER's receive time, stamped on insert and used by the
  // anti-spam counts below — never the client's `created_at` (which a sender
  // controls and could back-date to dodge the window). Defaults to created_at
  // for direct callers/tests that don't exercise admission.
  put(m: WireMessage, receivedAt?: number): void | Promise<void>;
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

  // --- Anti-spam admission (PLAN open Q#7) ----------------------------------
  // A sender is "known" to a recipient once that recipient has sent them at
  // least one message (recorded on put). Known senders bypass new-sender
  // throttling; unknown ones are bounded by the two rolling-window counts below.
  isKnownSender(recipient: string, sender: string): boolean | Promise<boolean>;
  // How many messages this (unknown) sender has landed for the recipient with a
  // receive time at/after `since` — the per-pair flood limit.
  countRecentFromPair(
    recipient: string,
    sender: string,
    since: number,
  ): number | Promise<number>;
  // How many messages from ALL not-yet-known senders the recipient has received
  // since `since` — the Sybil backstop (many fresh keys, one ceiling).
  countRecentUnknown(recipient: string, since: number): number | Promise<number>;
  // How many messages this sender has sent since `since` to recipients who don't
  // yet know them (cold outreach) — bounds one identity's total spray reach.
  countRecentSentToNew(sender: string, since: number): number | Promise<number>;
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
      received_at INTEGER,
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
    -- Directed "known pair" ledger: (owner, peer) means owner has sent ≥1
    -- message to peer. Drives the new-sender exemption and survives the message
    -- retention sweep, so a contact stays known after their mail is purged.
    CREATE TABLE IF NOT EXISTS known (
      owner       TEXT NOT NULL,
      peer        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (owner, peer)
    );
  `);
  // Self-heal a dev DB created before received_at existed (the CREATE above is a
  // no-op on an existing table). Throws if the column is already there — fine.
  // MUST run before idx_admission below, which indexes received_at and would
  // otherwise fail to create on a pre-received_at table.
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN received_at INTEGER`);
  } catch {
    /* column already present */
  }
  // Created after the column is guaranteed to exist (fresh or self-healed).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_admission ON messages (recipient, sender, received_at)`);

  return {
    put(m, receivedAt = m.created_at) {
      db.prepare(
        `INSERT INTO messages (id, recipient, sender, body, tags, created_at, received_at, fetched_at, in_reply_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(m.id, m.recipient, m.sender, m.body, m.tags, m.created_at, receivedAt, m.in_reply_to);
      // The sender has now reached out to the recipient: record the directed
      // pair so the recipient's reply is exempt from throttling forever (and so
      // THIS sender becomes known once the recipient writes back).
      db.prepare(
        `INSERT OR IGNORE INTO known (owner, peer, created_at) VALUES (?, ?, ?)`,
      ).run(m.sender, m.recipient, receivedAt);
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

    isKnownSender(recipient, sender) {
      return !!db
        .prepare(`SELECT 1 FROM known WHERE owner = ? AND peer = ? LIMIT 1`)
        .get(recipient, sender);
    },

    countRecentFromPair(recipient, sender, since) {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE recipient = ? AND sender = ? AND received_at >= ?`,
        )
        .get(recipient, sender, since) as { n: number };
      return Number(r?.n ?? 0);
    },

    countRecentUnknown(recipient, since) {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m
           WHERE m.recipient = ? AND m.received_at >= ?
             AND NOT EXISTS (
               SELECT 1 FROM known k WHERE k.owner = m.recipient AND k.peer = m.sender
             )`,
        )
        .get(recipient, since) as { n: number };
      return Number(r?.n ?? 0);
    },

    countRecentSentToNew(sender, since) {
      // Cold outreach: this sender's messages to recipients who have NOT written
      // back (recipient doesn't "know" the sender), within the window.
      const r = db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m
           WHERE m.sender = ? AND m.received_at >= ?
             AND NOT EXISTS (
               SELECT 1 FROM known k WHERE k.owner = m.recipient AND k.peer = m.sender
             )`,
        )
        .get(sender, since) as { n: number };
      return Number(r?.n ?? 0);
    },
  };
}
