// Storage seam for the hosted mailbox. The Hono app talks to this interface,
// so the same routes run on Node (node:sqlite, below) or Cloudflare D1 (a thin
// adapter implementing the same calls — see store-d1.ts). A mailbox is just
// (recipient, blob, created_at); it never sees plaintext. The `handles` table
// is a small directory: short 6-char handle → a user's public keys, so people
// can address each other by a phone-number-style code instead of a long key.

import { DatabaseSync } from "node:sqlite";
import type { WireMessage } from "../src/identity.ts";
import { randomId } from "./token.ts";

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

// --- Account layer (AUTH-SYNC.md) -------------------------------------------
export interface AccountRecord {
  id: string;
  email: string;
  signPub: string | null;
  paid: boolean;
}

// What a poll resolves to. "pending" = link not clicked yet; "expired" = no such
// (or already-claimed) login; "ready" = mint a session and hand it back.
export type LoginPoll =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ready"; email: string };

export interface VaultRecord {
  blob: string;
  version: number;
}

// --- Contacts of contacts (CONTACTS-OF-CONTACTS.md) -------------------------
// One person in the caller's second-degree network: their own public identity
// (handle/name/boxPub, so you can write them) plus WHY they surfaced — how many
// of your contacts have them (`mutuals`, for ranking) and which (`via`, signPubs
// the client maps to your nicknames). No tags, no nicknames: a bare reachable node.
export interface NetworkPerson {
  signPub: string;
  boxPub: string;
  handle: string;
  name: string | null; // their own self-name; null if they never set one
  mutuals: number;
  via: string[]; // signPubs of YOUR contacts who link to them
}

export interface Store {
  // `receivedAt` is the SERVER's receive time, stamped on insert and used by the
  // anti-spam counts below — never the client's `created_at` (which a sender
  // controls and could back-date to dodge the window). Defaults to created_at
  // for direct callers/tests that don't exercise admission.
  put(m: WireMessage, receivedAt?: number): void | Promise<void>;
  summary(recipient: string): MailSummary[] | Promise<MailSummary[]>;
  drain(recipient: string, now: number): WireMessage[] | Promise<WireMessage[]>;
  // Directory: claim a handle for a key (idempotent for the same owner). `name`
  // is the owner's public self-name (already broadcast with every message); stored
  // so the contacts-of-contacts view can show a second-degree person by their own
  // name. Optional + COALESCEd, so a nameless re-register never wipes a stored name.
  registerHandle(
    handle: string,
    signPub: string,
    boxPub: string,
    now: number,
    name?: string,
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

  // --- Account layer (AUTH-SYNC.md) -----------------------------------------
  // Get the account for an email, creating it (unpaid, no signPub) if new. Email
  // is the stable identity; idempotent so repeated logins reuse the same account.
  getOrCreateAccount(email: string, now: number): AccountRecord | Promise<AccountRecord>;
  // Bind the user's mailbox key to the account on first sync (no-op if unchanged).
  bindAccountSignPub(accountId: string, signPub: string, now: number): void | Promise<void>;
  // Flip the paid flag (Stripe webhook). Idempotent.
  setAccountPaid(accountId: string, now: number): void | Promise<void>;

  // Magic link: stash a single-use token (hashed) + its poll handle.
  createLoginToken(
    tokenHash: string,
    email: string,
    pollId: string,
    expiresAt: number,
    now: number,
  ): void | Promise<void>;
  // Mark a login consumed when the emailed link is clicked. Returns false if the
  // token is unknown / expired / already consumed (so /auth/verify can 4xx).
  consumeLoginToken(tokenHash: string, now: number): boolean | Promise<boolean>;
  // The CLI polls this. On "ready" the caller mints a session, then must call
  // claimLogin(pollId) so the one-shot token can't mint a second session.
  pollLogin(pollId: string, now: number): LoginPoll | Promise<LoginPoll>;
  // Delete the login row once a session has been minted from it.
  claimLogin(pollId: string): void | Promise<void>;

  // Sessions (bearer auth for the vault routes), stored hashed.
  createSession(
    tokenHash: string,
    accountId: string,
    expiresAt: number,
    now: number,
  ): void | Promise<void>;
  // Resolve a bearer token to its account, or null if unknown/expired. Bumps
  // last_seen as a side effect.
  accountBySession(tokenHash: string, now: number): AccountRecord | null | Promise<AccountRecord | null>;
  // Log a single device out.
  deleteSession(tokenHash: string): void | Promise<void>;

  // Vault: the synced account blob. Read returns null when nothing's stored yet.
  getVault(accountId: string): VaultRecord | null | Promise<VaultRecord | null>;
  // Last-write-wins on `version`: writes only when newer than what's stored.
  // Returns "ok" on write, or "stale" with the current row when the caller is
  // behind (so the client can pull, merge, and retry).
  putVault(
    accountId: string,
    blob: string,
    version: number,
    now: number,
  ): "ok" | { stale: VaultRecord } | Promise<"ok" | { stale: VaultRecord }>;
  // Retention sweep for the account layer: drop expired login tokens + sessions.
  purgeAuth(now: number): number | Promise<number>;

  // --- Contacts of contacts (CONTACTS-OF-CONTACTS.md) -----------------------
  // Record that `owner` has these `contacts` in their address book (upsert, keyed
  // by signPub). Pushed by the local identity on every contact add — no account
  // needed — so the second-degree graph covers everyone.
  addEdges(owner: string, contacts: string[], now: number): void | Promise<void>;
  // Drop one edge when the owner deletes that contact.
  removeEdge(owner: string, contact: string): void | Promise<void>;
  // The caller's contacts-of-contacts: their contacts' contacts, minus the ones
  // they already have and minus anyone hidden, ranked by shared count. Capped at
  // `limit`. Only returns people with a registered handle (reachable).
  contactsOfContacts(owner: string, limit: number): NetworkPerson[] | Promise<NetworkPerson[]>;
  // Quiet opt-out: never surface this signPub in anyone's results. Never prompted.
  hideFromNetwork(signPub: string, now: number): void | Promise<void>;
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
      name        TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handles_signpub ON handles (signPub);
    -- Contacts of contacts (CONTACTS-OF-CONTACTS.md): the second-degree graph.
    -- One row per (owner, contact) address-book edge, keyed by signPub.
    CREATE TABLE IF NOT EXISTS edges (
      owner    TEXT NOT NULL,
      contact  TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (owner, contact)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_owner   ON edges (owner);
    CREATE INDEX IF NOT EXISTS idx_edges_contact ON edges (contact);
    -- Quiet opt-out: signPubs that never appear in anyone's results.
    CREATE TABLE IF NOT EXISTS edge_hidden (
      signpub TEXT PRIMARY KEY,
      since   INTEGER NOT NULL
    );
    -- Directed "known pair" ledger: (owner, peer) means owner has sent ≥1
    -- message to peer. Drives the new-sender exemption and survives the message
    -- retention sweep, so a contact stays known after their mail is purged.
    CREATE TABLE IF NOT EXISTS known (
      owner       TEXT NOT NULL,
      peer        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (owner, peer)
    );
    -- Account layer (AUTH-SYNC.md). Kept in step with server-mailbox/schema.sql.
    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      signPub     TEXT,
      paid        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_signpub ON accounts (signPub);
    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash  TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      poll_id     TEXT NOT NULL,
      consumed_at INTEGER,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_login_poll ON login_tokens (poll_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      last_seen   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);
    CREATE TABLE IF NOT EXISTS vault (
      account_id  TEXT PRIMARY KEY,
      blob        TEXT NOT NULL,
      version     INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
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
  // Same self-heal for the directory's public display name (added for
  // contacts-of-contacts): a no-op CREATE won't add it to an existing handles table.
  try {
    db.exec(`ALTER TABLE handles ADD COLUMN name TEXT`);
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
      // Mark-and-return in ONE atomic statement: a message that arrives between
      // a separate SELECT and UPDATE can't get marked fetched but not returned
      // (lost mail). Rows are MARKED, not deleted, so they keep counting toward
      // the anti-spam window (received_at is untouched). RETURNING has no ORDER
      // BY, so sort by created_at after.
      const rows = db
        .prepare(
          `UPDATE messages SET fetched_at = ? WHERE recipient = ? AND fetched_at IS NULL
           RETURNING id, recipient, sender, body, tags, created_at, in_reply_to`,
        )
        .all(now, recipient) as unknown as WireMessage[];
      rows.sort((a, b) => a.created_at - b.created_at);
      return rows;
    },

    registerHandle(handle, signPub, boxPub, now, name) {
      const existing = db.prepare(`SELECT signPub FROM handles WHERE handle = ?`).get(handle) as
        | { signPub: string }
        | undefined;
      if (existing && existing.signPub !== signPub) return "taken";
      db.prepare(
        `INSERT INTO handles (handle, signPub, boxPub, name, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET boxPub = excluded.boxPub,
           name = COALESCE(excluded.name, handles.name)`,
      ).run(handle, signPub, boxPub, name ?? null, now);
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

    // --- Account layer ------------------------------------------------------
    getOrCreateAccount(email, now) {
      const e = email.toLowerCase();
      const found = db
        .prepare(`SELECT id, email, signPub, paid FROM accounts WHERE email = ?`)
        .get(e) as { id: string; email: string; signPub: string | null; paid: number } | undefined;
      if (found) return { id: found.id, email: found.email, signPub: found.signPub, paid: !!found.paid };
      const id = randomId();
      db.prepare(
        `INSERT INTO accounts (id, email, signPub, paid, created_at, updated_at)
         VALUES (?, ?, NULL, 0, ?, ?)`,
      ).run(id, e, now, now);
      return { id, email: e, signPub: null, paid: false };
    },

    bindAccountSignPub(accountId, signPub, now) {
      db.prepare(`UPDATE accounts SET signPub = ?, updated_at = ? WHERE id = ?`).run(
        signPub,
        now,
        accountId,
      );
    },

    setAccountPaid(accountId, now) {
      db.prepare(`UPDATE accounts SET paid = 1, updated_at = ? WHERE id = ?`).run(now, accountId);
    },

    createLoginToken(tokenHash, email, pollId, expiresAt, now) {
      db.prepare(
        `INSERT INTO login_tokens (token_hash, email, poll_id, consumed_at, expires_at, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      ).run(tokenHash, email.toLowerCase(), pollId, expiresAt, now);
    },

    consumeLoginToken(tokenHash, now) {
      // One atomic conditional update: only an unconsumed, unexpired token flips,
      // so a double-click or a replay of the link can't re-consume it.
      const res = db
        .prepare(
          `UPDATE login_tokens SET consumed_at = ?
           WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(now, tokenHash, now);
      return Number(res.changes ?? 0) > 0;
    },

    pollLogin(pollId, now) {
      const row = db
        .prepare(`SELECT email, consumed_at, expires_at FROM login_tokens WHERE poll_id = ?`)
        .get(pollId) as { email: string; consumed_at: number | null; expires_at: number } | undefined;
      if (!row || row.expires_at <= now) return { status: "expired" as const };
      if (row.consumed_at == null) return { status: "pending" as const };
      return { status: "ready" as const, email: row.email };
    },

    claimLogin(pollId) {
      db.prepare(`DELETE FROM login_tokens WHERE poll_id = ?`).run(pollId);
    },

    createSession(tokenHash, accountId, expiresAt, now) {
      db.prepare(
        `INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(tokenHash, accountId, now, expiresAt, now);
    },

    accountBySession(tokenHash, now) {
      const row = db
        .prepare(
          `SELECT a.id, a.email, a.signPub, a.paid, s.expires_at
           FROM sessions s JOIN accounts a ON a.id = s.account_id
           WHERE s.token_hash = ?`,
        )
        .get(tokenHash) as
        | { id: string; email: string; signPub: string | null; paid: number; expires_at: number }
        | undefined;
      if (!row || row.expires_at <= now) return null;
      db.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).run(now, tokenHash);
      return { id: row.id, email: row.email, signPub: row.signPub, paid: !!row.paid };
    },

    deleteSession(tokenHash) {
      db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    },

    getVault(accountId) {
      const row = db
        .prepare(`SELECT blob, version FROM vault WHERE account_id = ?`)
        .get(accountId) as { blob: string; version: number } | undefined;
      return row ? { blob: row.blob, version: Number(row.version) } : null;
    },

    putVault(accountId, blob, version, now) {
      const cur = db
        .prepare(`SELECT blob, version FROM vault WHERE account_id = ?`)
        .get(accountId) as { blob: string; version: number } | undefined;
      if (cur && Number(cur.version) >= version)
        return { stale: { blob: cur.blob, version: Number(cur.version) } };
      db.prepare(
        `INSERT INTO vault (account_id, blob, version, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET blob = excluded.blob,
           version = excluded.version, updated_at = excluded.updated_at`,
      ).run(accountId, blob, version, now);
      return "ok";
    },

    purgeAuth(now) {
      const a = db.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).run(now);
      const b = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
      return Number(a.changes ?? 0) + Number(b.changes ?? 0);
    },

    // --- Contacts of contacts ----------------------------------------------
    addEdges(owner, contacts, now) {
      const stmt = db.prepare(
        `INSERT INTO edges (owner, contact, added_at) VALUES (?, ?, ?)
         ON CONFLICT(owner, contact) DO NOTHING`,
      );
      for (const contact of contacts) {
        if (contact && contact !== owner) stmt.run(owner, contact, now);
      }
    },

    removeEdge(owner, contact) {
      db.prepare(`DELETE FROM edges WHERE owner = ? AND contact = ?`).run(owner, contact);
    },

    contactsOfContacts(owner, limit) {
      // Self-join: my edges (e1) → my contacts' edges (e2). Exclude myself, people
      // I already have, and anyone hidden. INNER JOIN handles so only reachable
      // (registered) people surface, carrying handle/name/boxPub to write them.
      const rows = db
        .prepare(
          `SELECT e2.contact AS signPub, h.handle AS handle, h.name AS name, h.boxPub AS boxPub,
                  COUNT(*) AS mutuals, GROUP_CONCAT(e1.contact) AS via
           FROM edges e1
           JOIN edges e2 ON e2.owner = e1.contact
           JOIN handles h ON h.signPub = e2.contact
           WHERE e1.owner = ?
             AND e2.contact <> ?
             AND e2.contact NOT IN (SELECT contact FROM edges WHERE owner = ?)
             AND e2.contact NOT IN (SELECT signpub FROM edge_hidden)
           GROUP BY e2.contact
           ORDER BY mutuals DESC, MAX(e2.added_at) DESC
           LIMIT ?`,
        )
        .all(owner, owner, owner, limit) as unknown as {
        signPub: string;
        handle: string;
        name: string | null;
        boxPub: string;
        mutuals: number;
        via: string;
      }[];
      return rows.map((r) => ({
        signPub: r.signPub,
        boxPub: r.boxPub,
        handle: r.handle,
        name: r.name,
        mutuals: Number(r.mutuals),
        via: r.via ? r.via.split(",") : [],
      }));
    },

    hideFromNetwork(signPub, now) {
      db.prepare(
        `INSERT INTO edge_hidden (signpub, since) VALUES (?, ?) ON CONFLICT(signpub) DO NOTHING`,
      ).run(signPub, now);
    },
  };
}
