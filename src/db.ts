// Local inbox cache: a small SQLite file on the user's machine holding their
// decrypted recent messages (drained from the hosted mailbox). NOT the mailbox
// itself — that's the Cloudflare Worker + D1.
//
// Backed by node-sqlite3-wasm (SQLite compiled to WebAssembly) rather than the
// built-in node:sqlite, so the published package runs on Node 20+ on any OS with
// no native build step — node:sqlite is only usable unflagged on Node 24+, which
// silently broke installs on the Node 22 LTS line.

import sqlite from "node-sqlite3-wasm";
const { Database } = sqlite;

// The handle type consumers pass around (so nothing else imports the sqlite lib).
export type Mailbox = InstanceType<typeof Database>;

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

export function openMailbox(path: string): Mailbox {
  const db = new Database(path);
  // Best-effort durability/concurrency pragmas. WAL isn't supported by every
  // wasm VFS; the busy timeout helps the MCP server and the SessionStart hook
  // share one inbox.db. Harmless if the backend rejects them.
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;`);
  } catch {
    /* unsupported backend (e.g. :memory:) — fine */
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

export function insertMessage(db: Mailbox, m: MessageRow): void {
  db.run(
    `INSERT INTO messages
       (id, recipient, sender, body, tags, created_at, fetched_at, read_at, in_reply_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.recipient, m.sender, m.body, m.tags, m.created_at, m.fetched_at, m.read_at, m.in_reply_to],
  );
}

// Inbound messages for a user that haven't been surfaced (read) yet.
export function unreadFor(db: Mailbox, me: string): MessageRow[] {
  return db.all(
    `SELECT * FROM messages
       WHERE recipient = ? AND read_at IS NULL
       ORDER BY created_at ASC`,
    [me],
  ) as unknown as MessageRow[];
}

export function getMessage(db: Mailbox, id: string): MessageRow | undefined {
  // node-sqlite3-wasm returns null (not undefined) for a miss.
  return (db.get(`SELECT * FROM messages WHERE id = ?`, [id]) as unknown as MessageRow) ?? undefined;
}

export function markFetched(db: Mailbox, id: string, now: number): void {
  db.run(`UPDATE messages SET fetched_at = COALESCE(fetched_at, ?) WHERE id = ?`, [now, id]);
}

export function markRead(db: Mailbox, id: string, now: number): void {
  db.run(`UPDATE messages SET read_at = ?, fetched_at = COALESCE(fetched_at, ?) WHERE id = ?`, [
    now,
    now,
    id,
  ]);
}
