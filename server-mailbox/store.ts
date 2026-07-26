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
  // FRIENDS.md: when true the handle is in requests-only mode — /resolve returns
  // 404, so the out-of-band send path is off. The route checks this and 404s.
  requestsOnly?: boolean;
}

// --- Friend requests (FRIENDS.md) -------------------------------------------
// One incoming connect request. Carries the requester's public keys + self-name
// (so the recipient can seal an accept back) and the mutual it came through.
export interface FriendRequestRecord {
  fromSignPub: string;
  fromBoxPub: string;
  fromName: string | null;
  viaSignPub: string | null;
  createdAt: number;
}

// A person who accepted your request: their public identity, so you can save
// them and (via boxPub) finally message them. Read-and-cleared like a mail drain.
export interface AcceptedRecord {
  signPub: string;
  boxPub: string;
  name: string | null;
}

// --- Send by email (EMAIL-SEND.md) -------------------------------------------
// A provisional identity minted when someone writes to an email that has no
// account yet. The server holds BOTH key halves until the email's owner claims
// the account by logging in (same exposure class as the account data key —
// AUTH-SYNC.md §4). `notifiedAt` is the once-EVER invite marker: it survives
// claim and key-purge alike, so a given email is never mailed twice.
export interface EmailStubRecord {
  email: string;
  signPub: string | null; // null once the keys were purged (re-minted on next resolve)
  boxPub: string | null;
  signSec: string | null; // null once claimed (secrets handed to the owner's device)
  boxSec: string | null;
  createdBy: string | null; // signPub of the sender whose resolve provisioned it
  createdAt: number;
  notifiedAt: number | null;
}

// --- Account layer (AUTH-SYNC.md) -------------------------------------------
export interface AccountRecord {
  id: string;
  email: string;
  signPub: string | null;
  paid: boolean;
  // Per-account symmetric data key (hex). Minted server-side on first login and
  // handed to the device over the authenticated channel; the CLIENT uses it to
  // encrypt the vault + history blobs before pushing. The server stores both the
  // key and the ciphertext (encryption-at-rest, not E2E — AUTH-SYNC.md §4).
  dataKey: string | null;
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

// One encrypted history chunk (a client-sealed batch of messages). `seq` is a
// per-account monotonic cursor: devices pull "everything after seq N".
export interface HistoryChunk {
  seq: number;
  blob: string;
}

// --- Contacts of contacts (CONTACTS-OF-CONTACTS.md, FRIENDS.md) --------------
// One person in the caller's second-degree network. Deliberately NAME-ONLY: it
// carries `signPub` (an opaque routing id used to address a connect request) but
// NOT `boxPub` or `handle` — so discovery cannot hand out send capability. A
// friend-of-friend is un-messageable by construction (no boxPub → can't seal);
// you reach them via a friend request they accept (FRIENDS.md §1, §4a). `mutuals`
// ranks; `via` are signPubs of YOUR contacts who link to them (mapped to nicks).
export interface NetworkPerson {
  signPub: string;
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

  // --- Send by email (EMAIL-SEND.md) ----------------------------------------
  // Read-only account lookup by email (getOrCreateAccount CREATES — resolve
  // must never mint account rows for arbitrary probed addresses).
  accountByEmail(email: string): AccountRecord | null | Promise<AccountRecord | null>;
  // A registered identity's public keys + directory state, from the handles
  // directory (reverse of resolveHandle). Null when the signPub has no handle.
  identityKeys(
    signPub: string,
  ):
    | { boxPub: string; name: string | null; requestsOnly: boolean }
    | null
    | Promise<{ boxPub: string; name: string | null; requestsOnly: boolean } | null>;
  getEmailStub(email: string): EmailStubRecord | null | Promise<EmailStubRecord | null>;
  // Insert a stub, or re-key one whose keys were purged. Preserves notified_at
  // across re-keys (the once-ever rule); resets created_at so fresh keys get a
  // fresh retention clock.
  upsertEmailStub(
    email: string,
    keys: { signPub: string; boxPub: string; signSec: string; boxSec: string },
    createdBy: string,
    now: number,
  ): void | Promise<void>;
  // Set the once-ever invite marker. Never cleared by anything.
  markEmailNotified(email: string, now: number): void | Promise<void>;
  // The email's owner finished setup with the stub's keys (they registered a
  // handle for its signPub): drop the private halves — the device holds them now.
  claimEmailStub(signPub: string): void | Promise<void>;
  // Provision cap: how many stubs this sender has caused since `since`.
  countRecentEmailProvisions(createdBy: string, since: number): number | Promise<number>;
  // Retention: null the keys of UNCLAIMED stubs older than `cutoff` that have no
  // mail still waiting. The row (and notified_at) remains as the once-ever
  // tombstone; a later resolve re-mints keys without re-emailing.
  purgeEmailStubs(cutoff: number): number | Promise<number>;

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
  // Get-or-set the account's data key atomically: `candidate` is written only when
  // no key exists yet, and the stored key is returned either way — so concurrent
  // logins can't mint two keys for one account.
  ensureDataKey(accountId: string, candidate: string, now: number): string | Promise<string>;
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
  // History (AUTH-SYNC.md): append-only, client-encrypted message chunks. Append
  // assigns each blob the next per-account seq and returns the last one written.
  appendHistory(accountId: string, blobs: string[], now: number): number | Promise<number>;
  // Pull chunks strictly after `since`, oldest first, capped at `limit`. `last` is
  // the account's newest seq so the caller knows whether to page again.
  historySince(
    accountId: string,
    since: number,
    limit: number,
  ): { chunks: HistoryChunk[]; last: number } | Promise<{ chunks: HistoryChunk[]; last: number }>;
  // Drop an account's whole history (unused by routes today; retention/tooling).
  deleteHistory(accountId: string): void | Promise<void>;

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

  // --- Friend requests (FRIENDS.md) -----------------------------------------
  // Create a connect request from `from` → `to`. The requester's boxPub/name are
  // looked up from their registered handle (not trusted from the client). Returns
  // "self" (to == from), "unregistered" (requester has no handle to send from),
  // "already_friends" (from already has an edge to to), "exists" (a pending
  // request already sits there), or "ok".
  createFriendRequest(
    from: string,
    to: string,
    via: string | null,
    now: number,
  ):
    | "ok" | "self" | "exists" | "already_friends" | "unregistered"
    | Promise<"ok" | "self" | "exists" | "already_friends" | "unregistered">;
  // Incoming requests waiting for `to`.
  listFriendRequests(to: string): FriendRequestRecord[] | Promise<FriendRequestRecord[]>;
  // `acceptor` accepts `requester`'s request: write BOTH edges (mutual), queue an
  // accept notification back to the requester (with the acceptor's keys), delete
  // the request, and return the requester's identity so the acceptor can save
  // them. null if there was no such request.
  acceptFriendRequest(
    acceptor: string,
    requester: string,
    now: number,
  ): AcceptedRecord | null | Promise<AcceptedRecord | null>;
  // Drop a request without connecting.
  declineFriendRequest(acceptor: string, requester: string): void | Promise<void>;
  // Read-and-clear the accept notifications waiting for `requester` (people who
  // accepted them). Draining these is how a requester gains the acceptor's boxPub.
  takeAccepts(requester: string): AcceptedRecord[] | Promise<AcceptedRecord[]>;

  // --- Handle controls (FRIENDS.md) -----------------------------------------
  // Turn requests-only mode on/off for this identity's handle (kills/reopens the
  // out-of-band /resolve path). No-op if the identity has no handle.
  setRequestsOnly(signPub: string, on: boolean, now: number): void | Promise<void>;
  // Swap this identity's handle for a fresh code: register newHandle → same keys,
  // delete every other handle row for this signPub. "taken" if newHandle belongs
  // to someone else; "no_identity" if this signPub has no handle to rotate.
  rotateHandle(
    signPub: string,
    newHandle: string,
    now: number,
  ): "ok" | "taken" | "no_identity" | Promise<"ok" | "taken" | "no_identity">;

  // --- Waiting-mail email (NOTIFY-EMAIL.md) ---------------------------------
  // Accounts due a "mail waiting" email: signPub bound, opted in, not yet
  // notified this away-stretch, and >= 1 unfetched message received before
  // `agedBefore`. count/senderNames cover ALL unfetched mail (not just aged).
  unreadEmailCandidates(
    agedBefore: number,
    limit: number,
  ): UnreadEmailCandidate[] | Promise<UnreadEmailCandidate[]>;
  // Set the away-stretch marker after a successful send.
  markUnreadNotified(signPub: string, now: number): void | Promise<void>;
  // The recipient drained (came online): re-arm for the next away-stretch.
  clearUnreadNotified(signPub: string): void | Promise<void>;
  // User opt-out toggle. No-op when the signPub has no account.
  setUnreadEmails(signPub: string, on: boolean, now: number): void | Promise<void>;
}

// One account due a waiting-mail email (NOTIFY-EMAIL.md). `senderNames` are
// self-chosen display names from the handles directory — untrusted content.
export interface UnreadEmailCandidate {
  email: string;
  signPub: string;
  count: number;
  senderNames: (string | null)[];
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
      handle        TEXT PRIMARY KEY,
      signPub       TEXT NOT NULL,
      boxPub        TEXT NOT NULL,
      name          TEXT,
      requests_only INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handles_signpub ON handles (signPub);
    -- Friend requests + accept notifications (FRIENDS.md). Kept in step with
    -- server-mailbox/schema.sql. All CREATE IF NOT EXISTS → safe to re-apply.
    CREATE TABLE IF NOT EXISTS friend_requests (
      to_signpub   TEXT NOT NULL,
      from_signpub TEXT NOT NULL,
      from_boxpub  TEXT NOT NULL,
      from_name    TEXT,
      via_signpub  TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (to_signpub, from_signpub)
    );
    CREATE INDEX IF NOT EXISTS idx_reqs_to ON friend_requests (to_signpub);
    CREATE TABLE IF NOT EXISTS friend_accepts (
      to_signpub   TEXT NOT NULL,
      peer_signpub TEXT NOT NULL,
      peer_boxpub  TEXT NOT NULL,
      peer_name    TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (to_signpub, peer_signpub)
    );
    CREATE INDEX IF NOT EXISTS idx_accepts_to ON friend_accepts (to_signpub);
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
    -- Send by email (EMAIL-SEND.md): provisional identities for written-to
    -- emails. Kept in step with server-mailbox/schema.sql. The row is a
    -- permanent once-ever tombstone: keys may be nulled (claim / purge), but
    -- notified_at is never reset.
    CREATE TABLE IF NOT EXISTS email_stubs (
      email       TEXT PRIMARY KEY,
      sign_pub    TEXT,
      box_pub     TEXT,
      sign_sec    TEXT,
      box_sec     TEXT,
      created_by  TEXT,
      created_at  INTEGER NOT NULL,
      notified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_email_stubs_signpub ON email_stubs (sign_pub);
    -- Account layer (AUTH-SYNC.md). Kept in step with server-mailbox/schema.sql.
    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      signPub     TEXT,
      paid        INTEGER NOT NULL DEFAULT 0,
      data_key    TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      unread_notified_at INTEGER,
      unread_emails      INTEGER NOT NULL DEFAULT 1
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
    -- Message history (AUTH-SYNC.md): append-only, client-encrypted chunks with a
    -- per-account monotonic seq. Devices push what they saw and pull past their
    -- cursor; the server can't read the blobs.
    CREATE TABLE IF NOT EXISTS history (
      account_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      blob        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (account_id, seq)
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
  // Same self-heal for requests-only mode (FRIENDS.md), added later still.
  try {
    db.exec(`ALTER TABLE handles ADD COLUMN requests_only INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* column already present */
  }
  // Same self-heal for the per-account data key (encrypted vault/history).
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN data_key TEXT`);
  } catch {
    /* column already present */
  }
  // Same self-heal for the waiting-mail email columns (NOTIFY-EMAIL.md).
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN unread_notified_at INTEGER`);
  } catch {
    /* column already present */
  }
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN unread_emails INTEGER NOT NULL DEFAULT 1`);
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
      const row = db
        .prepare(`SELECT signPub, boxPub, requests_only FROM handles WHERE handle = ?`)
        .get(handle) as { signPub: string; boxPub: string; requests_only: number } | undefined;
      if (!row) return null;
      return { signPub: row.signPub, boxPub: row.boxPub, requestsOnly: !!row.requests_only };
    },

    isRegistered(signPub) {
      // A live email stub is deliverable too (EMAIL-SEND.md): mail sealed to a
      // provisional identity waits for its owner to claim the account.
      return (
        !!db.prepare(`SELECT 1 FROM handles WHERE signPub = ? LIMIT 1`).get(signPub) ||
        !!db
          .prepare(`SELECT 1 FROM email_stubs WHERE sign_pub = ? LIMIT 1`)
          .get(signPub)
      );
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

    // --- Send by email (EMAIL-SEND.md) --------------------------------------
    accountByEmail(email) {
      const found = db
        .prepare(`SELECT id, email, signPub, paid, data_key FROM accounts WHERE email = ?`)
        .get(email.toLowerCase()) as
        | { id: string; email: string; signPub: string | null; paid: number; data_key: string | null }
        | undefined;
      if (!found) return null;
      return {
        id: found.id,
        email: found.email,
        signPub: found.signPub,
        paid: !!found.paid,
        dataKey: found.data_key,
      };
    },

    identityKeys(signPub) {
      const row = db
        .prepare(`SELECT boxPub, name, requests_only FROM handles WHERE signPub = ? LIMIT 1`)
        .get(signPub) as { boxPub: string; name: string | null; requests_only: number } | undefined;
      if (!row) return null;
      return { boxPub: row.boxPub, name: row.name, requestsOnly: !!row.requests_only };
    },

    getEmailStub(email) {
      const row = db
        .prepare(
          `SELECT email, sign_pub, box_pub, sign_sec, box_sec, created_by, created_at, notified_at
           FROM email_stubs WHERE email = ?`,
        )
        .get(email.toLowerCase()) as
        | {
            email: string;
            sign_pub: string | null;
            box_pub: string | null;
            sign_sec: string | null;
            box_sec: string | null;
            created_by: string | null;
            created_at: number;
            notified_at: number | null;
          }
        | undefined;
      if (!row) return null;
      return {
        email: row.email,
        signPub: row.sign_pub,
        boxPub: row.box_pub,
        signSec: row.sign_sec,
        boxSec: row.box_sec,
        createdBy: row.created_by,
        createdAt: Number(row.created_at),
        notifiedAt: row.notified_at == null ? null : Number(row.notified_at),
      };
    },

    upsertEmailStub(email, keys, createdBy, now) {
      // notified_at is deliberately NOT in the update set: the once-ever invite
      // marker survives a re-key of a purged stub.
      db.prepare(
        `INSERT INTO email_stubs (email, sign_pub, box_pub, sign_sec, box_sec, created_by, created_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(email) DO UPDATE SET
           sign_pub = excluded.sign_pub, box_pub = excluded.box_pub,
           sign_sec = excluded.sign_sec, box_sec = excluded.box_sec,
           created_by = excluded.created_by, created_at = excluded.created_at`,
      ).run(email.toLowerCase(), keys.signPub, keys.boxPub, keys.signSec, keys.boxSec, createdBy, now);
    },

    markEmailNotified(email, now) {
      db.prepare(`UPDATE email_stubs SET notified_at = ? WHERE email = ? AND notified_at IS NULL`).run(
        now,
        email.toLowerCase(),
      );
    },

    claimEmailStub(signPub) {
      db.prepare(`UPDATE email_stubs SET sign_sec = NULL, box_sec = NULL WHERE sign_pub = ?`).run(
        signPub,
      );
    },

    countRecentEmailProvisions(createdBy, since) {
      const r = db
        .prepare(`SELECT COUNT(*) AS n FROM email_stubs WHERE created_by = ? AND created_at >= ?`)
        .get(createdBy, since) as { n: number };
      return Number(r?.n ?? 0);
    },

    purgeEmailStubs(cutoff) {
      // Only UNCLAIMED stubs (secrets still held) with no mail waiting: purging
      // keys under waiting mail would strand it. The row itself stays — it IS
      // the once-ever tombstone.
      const res = db
        .prepare(
          `UPDATE email_stubs SET sign_pub = NULL, box_pub = NULL, sign_sec = NULL, box_sec = NULL
           WHERE sign_sec IS NOT NULL AND created_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.recipient = email_stubs.sign_pub AND m.fetched_at IS NULL
             )`,
        )
        .run(cutoff);
      return Number(res.changes ?? 0);
    },

    // --- Account layer ------------------------------------------------------
    getOrCreateAccount(email, now) {
      const e = email.toLowerCase();
      const found = db
        .prepare(`SELECT id, email, signPub, paid, data_key FROM accounts WHERE email = ?`)
        .get(e) as
        | { id: string; email: string; signPub: string | null; paid: number; data_key: string | null }
        | undefined;
      if (found)
        return {
          id: found.id,
          email: found.email,
          signPub: found.signPub,
          paid: !!found.paid,
          dataKey: found.data_key,
        };
      const id = randomId();
      db.prepare(
        `INSERT INTO accounts (id, email, signPub, paid, created_at, updated_at)
         VALUES (?, ?, NULL, 0, ?, ?)`,
      ).run(id, e, now, now);
      return { id, email: e, signPub: null, paid: false, dataKey: null };
    },

    bindAccountSignPub(accountId, signPub, now) {
      db.prepare(`UPDATE accounts SET signPub = ?, updated_at = ? WHERE id = ?`).run(
        signPub,
        now,
        accountId,
      );
    },

    ensureDataKey(accountId, candidate, now) {
      // Conditional write, then read back: only the first caller's candidate
      // lands, and every caller returns the same stored key.
      db.prepare(
        `UPDATE accounts SET data_key = ?, updated_at = ? WHERE id = ? AND data_key IS NULL`,
      ).run(candidate, now, accountId);
      const row = db.prepare(`SELECT data_key FROM accounts WHERE id = ?`).get(accountId) as
        | { data_key: string | null }
        | undefined;
      return row?.data_key ?? candidate;
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
          `SELECT a.id, a.email, a.signPub, a.paid, a.data_key, s.expires_at
           FROM sessions s JOIN accounts a ON a.id = s.account_id
           WHERE s.token_hash = ?`,
        )
        .get(tokenHash) as
        | {
            id: string;
            email: string;
            signPub: string | null;
            paid: number;
            data_key: string | null;
            expires_at: number;
          }
        | undefined;
      if (!row || row.expires_at <= now) return null;
      db.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).run(now, tokenHash);
      return {
        id: row.id,
        email: row.email,
        signPub: row.signPub,
        paid: !!row.paid,
        dataKey: row.data_key,
      };
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

    appendHistory(accountId, blobs, now) {
      // MAX+1 inside one implicit per-statement lock is enough here (node:sqlite
      // serialises writers); D1 mirrors the same shape.
      let last = 0;
      const insert = db.prepare(
        `INSERT INTO history (account_id, seq, blob, created_at)
         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM history WHERE account_id = ?`,
      );
      for (const blob of blobs) {
        insert.run(accountId, blob, now, accountId);
        const row = db
          .prepare(`SELECT MAX(seq) AS seq FROM history WHERE account_id = ?`)
          .get(accountId) as { seq: number | null };
        last = Number(row?.seq ?? 0);
      }
      if (!blobs.length) {
        const row = db
          .prepare(`SELECT MAX(seq) AS seq FROM history WHERE account_id = ?`)
          .get(accountId) as { seq: number | null };
        last = Number(row?.seq ?? 0);
      }
      return last;
    },

    historySince(accountId, since, limit) {
      const chunks = db
        .prepare(
          `SELECT seq, blob FROM history WHERE account_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(accountId, since, limit) as unknown as { seq: number; blob: string }[];
      const row = db
        .prepare(`SELECT MAX(seq) AS seq FROM history WHERE account_id = ?`)
        .get(accountId) as { seq: number | null };
      return {
        chunks: chunks.map((c) => ({ seq: Number(c.seq), blob: c.blob })),
        last: Number(row?.seq ?? 0),
      };
    },

    deleteHistory(accountId) {
      db.prepare(`DELETE FROM history WHERE account_id = ?`).run(accountId);
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
      // Mutual-only traversal (FRIENDS.md §4a): only CONFIRMED two-way friendships
      // propagate, so a one-way save can't leak someone into a stranger's network.
      //   e1  : me → friend        e1r : friend → me     (me ⇄ friend)
      //   e2  : friend → fof       e2r : fof → friend    (friend ⇄ fof)
      // Exclude myself, anyone I already have an edge to, and anyone hidden. JOIN
      // handles so only registered people surface, but return NAME ONLY — no
      // boxPub/handle — so discovery can't hand out send capability (§1). `signPub`
      // is an opaque routing id used to address a connect request.
      const rows = db
        .prepare(
          `SELECT e2.contact AS signPub, h.name AS name,
                  COUNT(*) AS mutuals, GROUP_CONCAT(e1.contact) AS via
           FROM edges e1
           JOIN edges e1r ON e1r.owner = e1.contact AND e1r.contact = e1.owner
           JOIN edges e2  ON e2.owner  = e1.contact
           JOIN edges e2r ON e2r.owner = e2.contact AND e2r.contact = e1.contact
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
        name: string | null;
        mutuals: number;
        via: string;
      }[];
      return rows.map((r) => ({
        signPub: r.signPub,
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

    // --- Friend requests (FRIENDS.md) --------------------------------------
    createFriendRequest(from, to, via, now) {
      if (!to || to === from) return "self";
      // Requester's public keys come from THEIR registered handle, never trusted
      // from the client — no handle means nothing to seal an accept back to.
      const me = db
        .prepare(`SELECT boxPub, name FROM handles WHERE signPub = ? LIMIT 1`)
        .get(from) as { boxPub: string; name: string | null } | undefined;
      if (!me) return "unregistered";
      // Already connected (I have an edge to them) → nothing to request.
      if (db.prepare(`SELECT 1 FROM edges WHERE owner = ? AND contact = ? LIMIT 1`).get(from, to))
        return "already_friends";
      const res = db
        .prepare(
          `INSERT INTO friend_requests (to_signpub, from_signpub, from_boxpub, from_name, via_signpub, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(to_signpub, from_signpub) DO NOTHING`,
        )
        .run(to, from, me.boxPub, me.name, via ?? null, now);
      return Number(res.changes ?? 0) > 0 ? "ok" : "exists";
    },

    listFriendRequests(to) {
      const rows = db
        .prepare(
          `SELECT from_signpub, from_boxpub, from_name, via_signpub, created_at
           FROM friend_requests WHERE to_signpub = ? ORDER BY created_at ASC`,
        )
        .all(to) as unknown as {
        from_signpub: string;
        from_boxpub: string;
        from_name: string | null;
        via_signpub: string | null;
        created_at: number;
      }[];
      return rows.map((r) => ({
        fromSignPub: r.from_signpub,
        fromBoxPub: r.from_boxpub,
        fromName: r.from_name,
        viaSignPub: r.via_signpub,
        createdAt: Number(r.created_at),
      }));
    },

    acceptFriendRequest(acceptor, requester, now) {
      const req = db
        .prepare(
          `SELECT from_boxpub, from_name FROM friend_requests
           WHERE to_signpub = ? AND from_signpub = ?`,
        )
        .get(acceptor, requester) as { from_boxpub: string; from_name: string | null } | undefined;
      if (!req) return null;
      // The acceptor's own keys (to hand back to the requester) come from their
      // registered handle — canonical, not client-claimed.
      const meRow = db
        .prepare(`SELECT boxPub, name FROM handles WHERE signPub = ? LIMIT 1`)
        .get(acceptor) as { boxPub: string; name: string | null } | undefined;
      // Mutual edges: both now have each other, so they're confirmed friends and
      // stop appearing in each other's contacts-of-contacts.
      const addEdge = db.prepare(
        `INSERT INTO edges (owner, contact, added_at) VALUES (?, ?, ?)
         ON CONFLICT(owner, contact) DO NOTHING`,
      );
      addEdge.run(acceptor, requester, now);
      addEdge.run(requester, acceptor, now);
      // Queue the accept back to the requester, carrying the acceptor's boxPub —
      // the send capability the requester gains only now.
      if (meRow)
        db.prepare(
          `INSERT INTO friend_accepts (to_signpub, peer_signpub, peer_boxpub, peer_name, created_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(to_signpub, peer_signpub) DO UPDATE SET
             peer_boxpub = excluded.peer_boxpub, peer_name = excluded.peer_name`,
        ).run(requester, acceptor, meRow.boxPub, meRow.name, now);
      db.prepare(`DELETE FROM friend_requests WHERE to_signpub = ? AND from_signpub = ?`).run(
        acceptor,
        requester,
      );
      return { signPub: requester, boxPub: req.from_boxpub, name: req.from_name };
    },

    declineFriendRequest(acceptor, requester) {
      db.prepare(`DELETE FROM friend_requests WHERE to_signpub = ? AND from_signpub = ?`).run(
        acceptor,
        requester,
      );
    },

    takeAccepts(requester) {
      const rows = db
        .prepare(
          `DELETE FROM friend_accepts WHERE to_signpub = ?
           RETURNING peer_signpub, peer_boxpub, peer_name`,
        )
        .all(requester) as unknown as {
        peer_signpub: string;
        peer_boxpub: string;
        peer_name: string | null;
      }[];
      return rows.map((r) => ({ signPub: r.peer_signpub, boxPub: r.peer_boxpub, name: r.peer_name }));
    },

    // --- Handle controls (FRIENDS.md) --------------------------------------
    setRequestsOnly(signPub, on, now) {
      db.prepare(`UPDATE handles SET requests_only = ? WHERE signPub = ?`).run(
        on ? 1 : 0,
        signPub,
      );
      void now;
    },

    rotateHandle(signPub, newHandle, now) {
      const mine = db
        .prepare(`SELECT boxPub, name, requests_only FROM handles WHERE signPub = ? LIMIT 1`)
        .get(signPub) as
        | { boxPub: string; name: string | null; requests_only: number }
        | undefined;
      if (!mine) return "no_identity";
      const taken = db.prepare(`SELECT signPub FROM handles WHERE handle = ?`).get(newHandle) as
        | { signPub: string }
        | undefined;
      if (taken && taken.signPub !== signPub) return "taken";
      // Claim the new code (carrying keys + mode), then drop every other code for
      // this identity — one active handle per signPub. Friends key on signPub, so
      // they're unaffected; anyone holding the old code now 404s on resolve.
      db.prepare(
        `INSERT INTO handles (handle, signPub, boxPub, name, requests_only, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET
           boxPub = excluded.boxPub, name = excluded.name, requests_only = excluded.requests_only`,
      ).run(newHandle, signPub, mine.boxPub, mine.name, mine.requests_only, now);
      db.prepare(`DELETE FROM handles WHERE signPub = ? AND handle <> ?`).run(signPub, newHandle);
      return "ok";
    },

    // --- Waiting-mail email (NOTIFY-EMAIL.md) ------------------------------
    unreadEmailCandidates(agedBefore, limit) {
      // Step 1: eligible accounts — one aged unfetched message is enough to
      // qualify; self-mail (sender = recipient) never counts.
      const candidates = db
        .prepare(
          `SELECT a.email, a.signPub FROM accounts a
           WHERE a.signPub IS NOT NULL
             AND a.unread_emails = 1
             AND a.unread_notified_at IS NULL
             AND EXISTS (SELECT 1 FROM messages m
                         WHERE m.recipient = a.signPub AND m.fetched_at IS NULL
                           AND m.sender <> a.signPub
                           AND m.received_at IS NOT NULL AND m.received_at < ?)
           LIMIT ?`,
        )
        .all(agedBefore, limit) as unknown as { email: string; signPub: string }[];
      // Step 2: the email reports EVERYTHING waiting, not just what aged past
      // the trigger — the user is away either way.
      return candidates.map((c) => {
        const { n } = db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages
             WHERE recipient = ? AND fetched_at IS NULL AND sender <> ?`,
          )
          .get(c.signPub, c.signPub) as unknown as { n: number };
        const names = db
          .prepare(
            `SELECT DISTINCT h.name AS name FROM messages m
             LEFT JOIN handles h ON h.signPub = m.sender
             WHERE m.recipient = ? AND m.fetched_at IS NULL AND m.sender <> ?`,
          )
          .all(c.signPub, c.signPub) as unknown as { name: string | null }[];
        return { email: c.email, signPub: c.signPub, count: n, senderNames: names.map((r) => r.name) };
      });
    },

    markUnreadNotified(signPub, now) {
      db.prepare(`UPDATE accounts SET unread_notified_at = ? WHERE signPub = ?`).run(now, signPub);
    },

    clearUnreadNotified(signPub) {
      db.prepare(
        `UPDATE accounts SET unread_notified_at = NULL
         WHERE signPub = ? AND unread_notified_at IS NOT NULL`,
      ).run(signPub);
    },

    setUnreadEmails(signPub, on, now) {
      db.prepare(`UPDATE accounts SET unread_emails = ? WHERE signPub = ?`).run(on ? 1 : 0, signPub);
      void now;
    },
  };
}
