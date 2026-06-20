// Phase 0 mailbox: a local SQLite file acting as the store-and-forward relay.
// No network, no encryption yet — schema mirrors §6 of PLAN.md minus the
// crypto/sig columns so Phase 1 can grow into it without a rewrite.

import { DatabaseSync } from "node:sqlite";

export interface MessageRow {
  id: string;
  recipient: string; // recipient user id
  sender: string; // sender user id
  body: string; // plaintext in Phase 0 (sealed ciphertext in Phase 1)
  tags: string | null; // JSON array, unused in Phase 0 but carried through
  created_at: number; // unix ms
  fetched_at: number | null; // null until pulled by recipient
  read_at: number | null; // null until surfaced to the human
  in_reply_to: string | null; // threading: id of the message this answers
}

export function openMailbox(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL + a busy timeout so the MCP server and the SessionStart hook can share
  // one inbox.db without locking each other out.
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;`);
  } catch {
    /* :memory: and some FS don't support WAL — harmless */
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      recipient   TEXT NOT NULL,
      sender      TEXT NOT NULL,
      body        TEXT NOT NULL,
      tags        TEXT,
      created_at  INTEGER NOT NULL,
      fetched_at  INTEGER,
      read_at     INTEGER,
      in_reply_to TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recipient ON messages (recipient, created_at);
  `);
  return db;
}

export function insertMessage(db: DatabaseSync, m: MessageRow): void {
  db.prepare(
    `INSERT INTO messages
       (id, recipient, sender, body, tags, created_at, fetched_at, read_at, in_reply_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    m.recipient,
    m.sender,
    m.body,
    m.tags,
    m.created_at,
    m.fetched_at,
    m.read_at,
    m.in_reply_to,
  );
}

// Inbound messages for a user that haven't been surfaced (read) yet.
export function unreadFor(db: DatabaseSync, me: string): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE recipient = ? AND read_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all(me) as unknown as MessageRow[];
}

export function getMessage(db: DatabaseSync, id: string): MessageRow | undefined {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
    | MessageRow
    | undefined;
}

export function markFetched(db: DatabaseSync, id: string, now: number): void {
  db.prepare(
    `UPDATE messages SET fetched_at = COALESCE(fetched_at, ?) WHERE id = ?`,
  ).run(now, id);
}

export function markRead(db: DatabaseSync, id: string, now: number): void {
  db.prepare(`UPDATE messages SET read_at = ?, fetched_at = COALESCE(fetched_at, ?) WHERE id = ?`).run(
    now,
    now,
    id,
  );
}
