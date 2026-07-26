-- Hosted mailbox schema (D1 / SQLite). Store-and-forward of encrypted blobs
-- keyed by recipient address. The server never sees plaintext.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  recipient   TEXT NOT NULL,   -- recipient signPub (mailbox key)
  sender      TEXT NOT NULL,   -- sender signPub
  body        TEXT NOT NULL,   -- base64 sealed-box ciphertext
  tags        TEXT,            -- reserved: encrypted meta tags (Phase 2)
  created_at  INTEGER NOT NULL,
  received_at INTEGER,         -- SERVER receive time; drives anti-spam counts
  fetched_at  INTEGER,         -- null until drained by the recipient
  in_reply_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_recipient ON messages (recipient, fetched_at);
-- Supports the daily retention sweep (DELETE ... WHERE created_at < ?).
CREATE INDEX IF NOT EXISTS idx_created ON messages (created_at);
-- Supports the new-sender admission counts (per-pair + per-recipient unknown).
CREATE INDEX IF NOT EXISTS idx_admission ON messages (recipient, sender, received_at);

-- Directed "known pair" ledger: (owner, peer) means owner has sent >= 1 message
-- to peer. Drives the new-sender throttle exemption; outlives message retention
-- so a contact stays known after their old mail is purged.
CREATE TABLE IF NOT EXISTS known (
  owner       TEXT NOT NULL,
  peer        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (owner, peer)
);

-- Directory: short 6-char handle → a user's public keys (phone-number style).
-- `name` is the owner's public self-name (already broadcast with every message);
-- stored so contacts-of-contacts can show a second-degree person by their own name.
-- On an existing D1 the CREATE is a no-op, so add the column once:
--   wrangler d1 execute cli-chat --remote --command "ALTER TABLE handles ADD COLUMN name TEXT"
-- `requests_only` (FRIENDS.md): when 1, GET /resolve/:handle returns 404 — the
-- out-of-band send path is off, so strangers can't turn the code into a boxPub.
-- The ONLY thing it changes; the user stays discoverable + requestable. On an
-- existing D1 the CREATE is a no-op, so add the column once:
--   wrangler d1 execute cli-chat --remote --command \
--     "ALTER TABLE handles ADD COLUMN requests_only INTEGER NOT NULL DEFAULT 0"
CREATE TABLE IF NOT EXISTS handles (
  handle        TEXT PRIMARY KEY,
  signPub       TEXT NOT NULL,
  boxPub        TEXT NOT NULL,
  name          TEXT,
  requests_only INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
-- Reverse lookup for the recipient-exists check on POST /messages.
CREATE INDEX IF NOT EXISTS idx_handles_signpub ON handles (signPub);

-- Contacts of contacts (CONTACTS-OF-CONTACTS.md): the second-degree graph. One
-- row per address-book edge (owner signPub → contact signPub), pushed by the
-- local identity on every contact add — no account needed. All CREATE IF NOT
-- EXISTS, so safe to (re-)apply on the live DB.
CREATE TABLE IF NOT EXISTS edges (
  owner    TEXT NOT NULL,
  contact  TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (owner, contact)
);
CREATE INDEX IF NOT EXISTS idx_edges_owner   ON edges (owner);
CREATE INDEX IF NOT EXISTS idx_edges_contact ON edges (contact);
-- Quiet opt-out: signPubs that never appear in anyone's results (never surfaced).
CREATE TABLE IF NOT EXISTS edge_hidden (
  signpub TEXT PRIMARY KEY,
  since   INTEGER NOT NULL
);

-- Friend requests (FRIENDS.md): the consent handshake for the network path. A
-- friend-of-friend is discovered as a NAME only (no boxPub → un-messageable);
-- to reach them you send a request, which carries YOUR public keys so the
-- recipient can seal an accept back. The recipient's boxPub is disclosed only on
-- accept (via friend_accepts), so discovery never hands out send capability.
-- One pending request per (to, from). Keys stored here are already-public
-- (same class as the handles directory) — no message body is ever server-readable.
CREATE TABLE IF NOT EXISTS friend_requests (
  to_signpub   TEXT NOT NULL,   -- recipient (routes delivery)
  from_signpub TEXT NOT NULL,   -- requester identity
  from_boxpub  TEXT NOT NULL,   -- so the recipient can seal an accept back
  from_name    TEXT,            -- requester self-name (shown on the card)
  via_signpub  TEXT,            -- which mutual it came through ("via Niels")
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (to_signpub, from_signpub)
);
CREATE INDEX IF NOT EXISTS idx_reqs_to ON friend_requests (to_signpub);

-- Accept notifications: when C accepts A's request, a row is written here for A
-- carrying C's public keys, so A learns the accept AND gains C's boxPub (the
-- send capability) on their next pull. Read-and-clear (like a mail drain).
CREATE TABLE IF NOT EXISTS friend_accepts (
  to_signpub   TEXT NOT NULL,   -- the original requester, being notified
  peer_signpub TEXT NOT NULL,   -- who accepted (now a confirmed friend)
  peer_boxpub  TEXT NOT NULL,   -- their sealing key — the capability being granted
  peer_name    TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (to_signpub, peer_signpub)
);
CREATE INDEX IF NOT EXISTS idx_accepts_to ON friend_accepts (to_signpub);

-- Send by email (EMAIL-SEND.md): provisional identities for written-to emails.
-- POST /email/resolve mints a keypair for an unknown address and holds BOTH
-- halves until the email's owner claims the account by logging in (secrets are
-- then nulled — the device holds them). `notified_at` is the once-EVER invite
-- marker: a given email is mailed at most once, forever — it survives claim
-- and the key purge (the row is a permanent tombstone). On an existing D1 the
-- CREATE below is applied once:
--   wrangler d1 execute cli-chat --remote --file server-mailbox/schema.sql
CREATE TABLE IF NOT EXISTS email_stubs (
  email       TEXT PRIMARY KEY,   -- lowercased
  sign_pub    TEXT,               -- null once keys were purged (re-minted on next resolve)
  box_pub     TEXT,
  sign_sec    TEXT,               -- null once claimed (handed to the owner's device)
  box_sec     TEXT,
  created_by  TEXT,               -- sender signPub whose resolve provisioned it
  created_at  INTEGER NOT NULL,
  notified_at INTEGER             -- once-ever invite marker; never reset
);
CREATE INDEX IF NOT EXISTS idx_email_stubs_signpub ON email_stubs (sign_pub);

-- ===========================================================================
-- Account layer (AUTH-SYNC.md): optional, paid online account for multi-device
-- login + full-state sync. Distinct from the mailbox above, which stays
-- zero-knowledge — these tables hold the (server-readable) account vault and the
-- magic-link/session machinery that gates it. Email is the recovery anchor.
-- ===========================================================================

-- One online account per paying user. `signPub` ties the account to the user's
-- mailbox identity; it's bound on the first sync. `paid` flips on the Stripe
-- webhook and gates the vault routes. `data_key` is the per-account symmetric
-- key (hex) minted on first login; the CLIENT encrypts vault/history blobs with
-- it before pushing (encryption at rest, not E2E — the server stores both).
-- On an existing D1 the CREATE is a no-op, so add the column once:
--   wrangler d1 execute cli-chat --remote --command "ALTER TABLE accounts ADD COLUMN data_key TEXT"
-- `unread_notified_at` / `unread_emails` (NOTIFY-EMAIL.md): the waiting-mail
-- email. `unread_notified_at` is the once-per-away-stretch marker — set when the
-- "mail waiting" email sends, cleared on every drain (the user came online), so
-- one absence gets at most one email. `unread_emails` = 0 is the user's opt-out.
-- On an existing D1 the CREATE is a no-op, so add the columns once:
--   wrangler d1 execute cli-chat --remote --command "ALTER TABLE accounts ADD COLUMN unread_notified_at INTEGER"
--   wrangler d1 execute cli-chat --remote --command "ALTER TABLE accounts ADD COLUMN unread_emails INTEGER NOT NULL DEFAULT 1"
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,   -- lowercased
  signPub     TEXT,                   -- bound on first sync
  paid        INTEGER NOT NULL DEFAULT 0,
  data_key    TEXT,                   -- minted on first login (hex, 32 bytes)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  unread_notified_at INTEGER,                    -- away-stretch marker (cleared on drain)
  unread_emails      INTEGER NOT NULL DEFAULT 1  -- 0 = opted out of waiting-mail emails
);
CREATE INDEX IF NOT EXISTS idx_accounts_signpub ON accounts (signPub);

-- Single-use magic-link tokens. Stored HASHED (sha256). The emailed link carries
-- the raw token; the CLI polls `poll_id` and never sees the hash. One-shot: the
-- row is deleted once a session is minted from it.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,       -- sha256(raw token)
  email       TEXT NOT NULL,
  poll_id     TEXT NOT NULL,
  consumed_at INTEGER,                -- set when the email link is clicked
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_poll ON login_tokens (poll_id);

-- Long-lived device sessions. Stored HASHED. Bearer auth for the vault routes.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,       -- sha256(session token)
  account_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);

-- The synced account state: one opaque blob per account (identity + contacts +
-- tags + settings + context files, assembled AND encrypted client-side).
-- `version` drives last-write-wins.
CREATE TABLE IF NOT EXISTS vault (
  account_id  TEXT PRIMARY KEY,
  blob        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Message history (AUTH-SYNC.md): append-only, client-encrypted chunks with a
-- per-account monotonic `seq`. Devices push the messages they saw and pull
-- everything past their cursor; the server never reads the blobs.
CREATE TABLE IF NOT EXISTS history (
  account_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  blob        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, seq)
);
