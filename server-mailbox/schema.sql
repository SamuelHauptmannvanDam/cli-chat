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
CREATE TABLE IF NOT EXISTS handles (
  handle      TEXT PRIMARY KEY,
  signPub     TEXT NOT NULL,
  boxPub      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
-- Reverse lookup for the recipient-exists check on POST /messages.
CREATE INDEX IF NOT EXISTS idx_handles_signpub ON handles (signPub);
