// Local inbox cache: a small SQLite file on the user's machine holding their
// decrypted recent messages (drained from the hosted mailbox). NOT the mailbox
// itself — that's the Cloudflare Worker + D1.
//
// TWO drivers behind one `Store` interface, picked at runtime (see chooseDriver):
//
//   • native  — node:sqlite (Node 24+, stable + unflagged). A long-lived handle
//               in WAL mode. Native file locking means the MCP server process
//               AND the SessionStart/per-prompt hook process can open the SAME
//               inbox.db at once (one writer + many readers) with no contention.
//
//   • wasm    — node-sqlite3-wasm (Node 22/23, no native build step). Its VFS
//               canNOT share a file across processes: a second opener gets
//               SQLITE_CANTOPEN while another process holds the handle. That was
//               the root of the "new mail never surfaced" bug — the warmer inside
//               the MCP server held inbox.db for the whole session, so the hook
//               process could never open it to notify. So on wasm we DON'T hold a
//               handle: every op does open→use→close (brief), with a bounded
//               retry to ride out the rare cross-process collision. (`:memory:`
//               can't be reopened per-op — each open is a fresh empty db — so it
//               keeps one persistent handle.)
//
// Net: callers just use openMailbox()/run/all/get and the helpers below; the
// concurrency story is entirely contained here. node:sqlite is the clean fix;
// the wasm per-op path is the floor-preserving fallback for Node < 24.

import { createRequire } from "node:module";
import sqlite from "node-sqlite3-wasm";

const { Database: WasmDatabase } = sqlite;

// node:sqlite is only stable + unflagged on Node 24+. Loading it on Node 22/23
// either throws or needs --experimental-sqlite (with a warning), so we gate on
// the major version. MESSENGER_DB_DRIVER=wasm|native forces a driver (tests).
type NativeDb = {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
  close(): void;
};
const nodeMajor = Number(process.versions.node.split(".")[0]);
const forcedDriver = process.env.MESSENGER_DB_DRIVER?.trim().toLowerCase();
function loadNative(): (new (path: string) => NativeDb) | undefined {
  try {
    return createRequire(import.meta.url)("node:sqlite").DatabaseSync as new (path: string) => NativeDb;
  } catch {
    return undefined; // older Node, or built without sqlite — fall back to wasm
  }
}
const NativeDatabase =
  nodeMajor >= 24 || forcedDriver === "native" ? loadNative() : undefined;

function chooseDriver(): "native" | "wasm" {
  if (forcedDriver === "wasm") return "wasm";
  if (forcedDriver === "native") return NativeDatabase ? "native" : "wasm";
  return NativeDatabase ? "native" : "wasm";
}

// A tiny store: the few SQL shapes the inbox needs, params passed as an array
// (matching node-sqlite3-wasm). Both drivers implement it; everything else in
// the app talks to this, never to a concrete driver.
export interface Store {
  run(sql: string, params?: unknown[]): void;
  all(sql: string, params?: unknown[]): unknown[];
  get(sql: string, params?: unknown[]): unknown;
  close(): void;
}

// The handle type consumers pass around (so nothing else imports a sqlite lib).
export type Mailbox = Store;

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
  answered_by?: string | null; // "assistant" when the sender's agent wrote it (AUTO-CHAT.md); absent/null = human
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    recipient   TEXT NOT NULL,
    sender      TEXT NOT NULL,
    body        TEXT NOT NULL,
    tags        TEXT,
    created_at  INTEGER NOT NULL,
    fetched_at  INTEGER,
    read_at     INTEGER,
    in_reply_to TEXT,
    answered_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recipient ON messages (recipient, created_at);
`;

// Columns added after 0.10.0. CREATE TABLE IF NOT EXISTS never alters an existing
// table, so a pre-upgrade inbox.db needs each new column bolted on; "duplicate
// column" just means it's already there.
const MIGRATIONS = [`ALTER TABLE messages ADD COLUMN answered_by TEXT`];
function applyMigrations(exec: (sql: string) => void): void {
  for (const sql of MIGRATIONS) {
    try {
      exec(sql);
    } catch {
      /* duplicate column — already migrated */
    }
  }
}

// ---- native (node:sqlite) -------------------------------------------------
// One persistent handle in WAL mode. Safe across processes, so the server can
// hold it for the whole session while the hook opens its own alongside.
class NativeStore implements Store {
  #db: NativeDb;
  constructor(path: string) {
    const Db = NativeDatabase!;
    this.#db = new Db(path);
    try {
      this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    } catch {
      /* :memory: or a VFS without WAL — fine */
    }
    this.#db.exec(SCHEMA);
    applyMigrations((sql) => this.#db.exec(sql));
  }
  run(sql: string, params: unknown[] = []): void {
    this.#db.prepare(sql).run(...params);
  }
  all(sql: string, params: unknown[] = []): unknown[] {
    return this.#db.prepare(sql).all(...params);
  }
  get(sql: string, params: unknown[] = []): unknown {
    return this.#db.prepare(sql).get(...params) ?? undefined;
  }
  close(): void {
    this.#db.close();
  }
}

// ---- wasm (node-sqlite3-wasm) ---------------------------------------------
// Block the thread briefly without spinning the CPU — only ever for a handful
// of milliseconds while retrying a cross-process open collision.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The wasm VFS throws CANTOPEN/"locked" if another process holds the file. With
// per-op open→close those windows are tiny, so a short bounded retry rides them
// out. Worst case ~0.6s before giving up (then the caller's own error handling
// takes over — e.g. the hook just stays quiet that turn).
function withRetry<T>(fn: () => T, attempts = 6): T {
  let delay = 15;
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const retriable = /unable to open|database is locked|database table is locked|is busy/i.test(msg);
      if (!retriable || i >= attempts) throw e;
      sleepSync(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

function openWasm(path: string) {
  const db = new WasmDatabase(path);
  // No WAL here on purpose: per-op open/close wants the default rollback journal,
  // which fully releases the file lock on close (and needs no -shm). busy_timeout
  // lets a brief writer-vs-reader overlap settle without an immediate error.
  try {
    db.exec("PRAGMA busy_timeout = 4000;");
  } catch {
    /* :memory: — fine */
  }
  db.exec(SCHEMA);
  applyMigrations((sql) => db.exec(sql));
  return db;
}

// Persistent wasm handle. Used for `:memory:` (which can't be reopened per-op)
// and as the in-process driver for tests.
class WasmMemoryStore implements Store {
  #db: InstanceType<typeof WasmDatabase>;
  constructor(path: string) {
    this.#db = openWasm(path);
  }
  run(sql: string, params: unknown[] = []): void {
    this.#db.run(sql, params as never);
  }
  all(sql: string, params: unknown[] = []): unknown[] {
    return this.#db.all(sql, params as never) as unknown[];
  }
  get(sql: string, params: unknown[] = []): unknown {
    return this.#db.get(sql, params as never) ?? undefined;
  }
  close(): void {
    this.#db.close();
  }
}

// Per-op wasm store: open → run the statement → close, every time. Holds the
// file for microseconds, so a separate process (the hook) can slip in between.
// This is what makes new mail surface again on Node < 24.
class WasmPerOpStore implements Store {
  #path: string;
  constructor(path: string) {
    this.#path = path; // no handle held; schema is created on first op (IF NOT EXISTS)
  }
  #with<T>(fn: (db: InstanceType<typeof WasmDatabase>) => T): T {
    return withRetry(() => {
      const db = openWasm(this.#path);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    });
  }
  run(sql: string, params: unknown[] = []): void {
    this.#with((db) => db.run(sql, params as never));
  }
  all(sql: string, params: unknown[] = []): unknown[] {
    return this.#with((db) => db.all(sql, params as never)) as unknown[];
  }
  get(sql: string, params: unknown[] = []): unknown {
    return this.#with((db) => db.get(sql, params as never)) ?? undefined;
  }
  close(): void {
    /* nothing persistent to close */
  }
}

export function openMailbox(path: string): Store {
  if (chooseDriver() === "native") return new NativeStore(path);
  if (path === ":memory:") return new WasmMemoryStore(path);
  return new WasmPerOpStore(path);
}

export function insertMessage(db: Mailbox, m: MessageRow): void {
  // OR IGNORE: the warmer and chat_batch can both drain + insert the same id
  // concurrently (especially the per-op wasm driver, where check-then-insert isn't
  // atomic). A duplicate id is then a harmless no-op rather than a PRIMARY KEY throw.
  db.run(
    `INSERT OR IGNORE INTO messages
       (id, recipient, sender, body, tags, created_at, fetched_at, read_at, in_reply_to, answered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.recipient, m.sender, m.body, m.tags, m.created_at, m.fetched_at, m.read_at, m.in_reply_to, m.answered_by ?? null],
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
  // Both drivers return undefined for a miss (wasm null is coerced in the store).
  return (db.get(`SELECT * FROM messages WHERE id = ?`, [id]) as unknown as MessageRow) ?? undefined;
}

// A chronological slice of the thread with one person (or with everyone, when
// `other` is null), BOTH directions — this is the `history` tool's query
// (HISTORY.md). Read-only by contract: it never touches read_at, so an unread
// message appearing in a history slice still surfaces through the normal inbox
// paths. Newest-first internally (so `limit` takes the most recent), returned
// oldest-first so it reads like a conversation.
export function historyFor(
  db: Mailbox,
  me: string,
  other: string | null,
  opts: { limit?: number; before?: number; q?: string } = {},
): MessageRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const where: string[] = [];
  const params: unknown[] = [];
  if (other) {
    where.push(`((recipient = ? AND sender = ?) OR (recipient = ? AND sender = ?))`);
    params.push(me, other, other, me);
  } else {
    where.push(`(recipient = ? OR sender = ?)`);
    params.push(me, me);
  }
  if (opts.before != null) {
    where.push(`created_at < ?`);
    params.push(opts.before);
  }
  if (opts.q) {
    // Substring match; escape LIKE wildcards so a literal "%" in the query
    // doesn't turn into match-everything.
    where.push(`body LIKE ? ESCAPE '\\'`);
    params.push(`%${opts.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  const rows = db.all(
    `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit],
  ) as unknown as MessageRow[];
  return rows.reverse();
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
