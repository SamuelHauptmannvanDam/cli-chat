# Online account: magic-link login + full-state sync

**What this is.** Accounts are **email-first**: `login` is the only front door.
A fresh device has nothing on it; any tool returns `no_account` until the user
logs in with their email. An email with an existing account **restores** it —
identity, contacts, tags, memory notes, thread digests, and full message
history. A brand-new email **creates** the account (the agent asks the user's
full name first). There is no anonymous/local-only account path and no
`create_account` tool anymore — accounts are born logged in, and everything the
account holds syncs to every device it's logged in on.

**Trade made (explicit).** This is **encryption at rest, not zero-knowledge**.
Every synced blob (vault + history chunks) is encrypted **client-side** with a
per-account `data_key` — but the server *mints* that key and stores it in the
accounts table, so it can decrypt what it stores. What this protects against is
a **database leak or dump** (stolen D1 export, misconfigured backup: ciphertext
only, key lives in a different table/row); what it does **not** protect against
is the server operator. Email remains the **master key** to the whole identity
— anyone who controls the email can log in and restore everything. **Wire
confidentiality is unchanged**: message *transport* is still sealed end-to-end
to the recipient's box key (`POST /messages` stores only ciphertext the server
has no key for).

**Unlock.** The billing machinery is a **one-time €1** purchase that flips a
`paid` flag the vault/history routes require — but it is currently **dormant**:
the Worker runs with `FREE_SYNC=1`, which makes online login/sync free for
everyone (the Stripe checkout/webhook stays wired, just never gates). Flip the
env var off to re-enable the gate.

**Sync cadence.** Pull at **session start**; push on local mutation (contact,
tag, settings, name, and identity changes mark the vault dirty; every message
sent or received queues in the history outbox). Pushes **wake the account's
other devices in real time**: the existing push socket carries `{t:"vault"}`
and `{t:"history"}` frames, so a change on one device lands on the others
within seconds with no manual step. Last-write-wins on a `version`
counter for the vault; the history stream is append-only with a cursor.

---

## 1. Auth choice: hand-rolled magic link (not Better Auth)

Better Auth is a self-hosted **library** (MIT, runs in our Worker, writes to our
D1 — no SaaS, no per-user billing). It's a fine tool, but its value is *breadth*
(social, passkeys, 2FA, web-cookie/CSRF sessions) — almost all dead weight for a
CLI whose entire auth surface is **one email method**, and whose "session" is a
long-lived device token saved next to the keys, not a browser cookie. So it's
hand-rolled. Reconsider Better Auth the day a **web dashboard or social login**
lands.

The flow is **device-authorization style**, because the user clicks the email link
in a browser but the *session* must land in the CLI:

```
  CLI/agent                    Worker (D1)                 User's email/browser
     │  login(email)              │                              │
     │ ──────────────────────────>│  create login_token         │
     │                            │  email link w/ token  ──────>│
     │  <─ {poll_id, interval} ───│                              │
     │                            │                  user clicks │
     │                            │<── GET /auth/verify?token ───│
     │                            │  mark token consumed,        │
     │                            │  bind to account             │
     │  poll(poll_id) ───────────>│                              │
     │  <─ {session_token,        │  (once verified)             │
     │      account{email, paid,  │                              │
     │      hasVault, dataKey}} ──│                              │
     │  save session locally      │                              │
```

- `login_token`: short, single-use, ~15 min expiry, **stored hashed** (SHA-256) in
  D1. The emailed link carries the raw token; we only ever compare hashes.
- `poll_id`: opaque id the CLI polls; resolves to a `session_token` once the link
  is clicked. (Avoids the CLI ever seeing the email token.) One-shot: the login
  row is claimed when the session is minted, so it can't mint a second one.
- `session_token`: long-lived (e.g. 1 year, renewable), random 32 bytes, stored
  hashed in D1, saved on device as `~/.cli-chat/users/<handle>/session.json`
  (alongside the account email, the `data_key`, the vault `version`, and the
  history cursor). Sent as `Authorization: Bearer <token>` on account routes.
- The poll response also carries the account's **`data_key`** (see §4) and
  `hasVault` — whether there's an account state to restore.

Rate-limit `login` per email + per IP (reuse the anti-spam shape already in
`server-mailbox/app.ts`). Single-use tokens, constant-time compare on the hash.

### What happens after the poll (client side, `establishSession`)

The poll authenticates; what the client does next depends on what exists:

| Email has… | Device has… | Result |
|---|---|---|
| an account (`hasVault`) | the **same** identity | Relogin: re-save the session, converge (vault + history round-trip). |
| an account (`hasVault`) | a **different** identity, or none | **The email's account wins.** Pull + decrypt the vault, adopt its identity; the old local identity's dir is **set aside on disk** (kept, not merged, not deleted — it just stops being current). Then pull history. |
| no account | an identity | Bind: save the session under it and push it online (the first push binds `signPub` server-side). |
| no account | nothing | **Create.** `login` returns `need_name`; the agent asks the user's full name and calls `login` again with the same `poll_id` plus `name`. That mints the keypair, claims a 6-char handle, and pushes the first vault — the identity is born bound to the email. (The minted session is parked in memory while waiting for the name; the poll token is already claimed.) |

The "email's account wins" rule is enforced server-side too: **`signPub` binds
once** — `PUT /vault` returns `403 identity_mismatch` on a push claiming a
different identity than the one bound to the account. Without this, logging in
on a device that holds another identity could silently take over the account's
vault (the hijack case). The only way to change an account's identity is
operator intervention.

### Two request-auth schemes coexist
- **Mailbox routes** (`/messages`, `/mailbox`, `/register`, `/resolve`): unchanged
  — Ed25519 request signatures (`src/auth.ts` + `server-mailbox/verify.ts`).
- **Account routes** (`/auth/*`, `/vault`, `/history`, `/account/key`): bearer
  `session_token`. Additive; doesn't touch the signature path.

---

## 2. D1 schema (account layer)

In `server-mailbox/schema.sql`:

```sql
-- One online account per user. Email is the recovery anchor; signPub ties the
-- account to the user's mailbox identity (bound once, on first push).
-- data_key is the per-account symmetric key (hex, 32 bytes) minted on first
-- login; the CLIENT encrypts vault/history blobs with it before pushing
-- (encryption at rest, not E2E — the server stores both).
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,        -- random account id (uuid-ish)
  email       TEXT NOT NULL UNIQUE,    -- lowercased
  signPub     TEXT,                    -- bound on first push, then immutable
  paid        INTEGER NOT NULL DEFAULT 0,
  data_key    TEXT,                    -- minted on first login (hex, 32 bytes)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_signpub ON accounts (signPub);

-- Single-use email login tokens (magic link). Stored hashed. One-shot: the row
-- is deleted once a session is minted from it.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,        -- sha256(raw token)
  email       TEXT NOT NULL,
  poll_id     TEXT NOT NULL,           -- CLI polls this; never sees token_hash
  consumed_at INTEGER,                 -- set when the email link is clicked
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_poll ON login_tokens (poll_id);

-- Long-lived device sessions. Stored hashed. Bearer auth for account routes.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,        -- sha256(session token)
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
  blob        TEXT NOT NULL,           -- client-encrypted ("enc1:…"), see §4
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Message history: append-only, client-encrypted chunks with a per-account
-- monotonic seq. Devices push what they saw and pull past their cursor; the
-- server never reads the blobs.
CREATE TABLE IF NOT EXISTS history (
  account_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  blob        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, seq)
);
```

On an existing D1 the `CREATE TABLE IF NOT EXISTS` for `accounts` is a no-op, so
the `data_key` column is added once by hand:

```
wrangler d1 execute cli-chat --remote --command "ALTER TABLE accounts ADD COLUMN data_key TEXT"
```

Retention sweep (the existing cron in the Worker): delete `login_tokens` past
`expires_at`, and expired `sessions`.

---

## 3. Worker routes

In `server-mailbox/app.ts` (Hono). All return JSON. "Pay gate" = requires
`paid=1` unless `FREE_SYNC=1` (the current state) waives it.

| Route | Auth | Body / query | Does |
|---|---|---|---|
| `POST /auth/login` | none (rate-limited) | `{ email }` | Create `login_token` + `poll_id`, email the link, return `{ poll_id, interval, expires_in }`. |
| `GET /auth/verify` | none | `?token=` | User's browser hits this from the email. Validate hash + expiry, set `consumed_at`. Render a "return to your terminal" page. |
| `POST /auth/poll` | none | `{ poll_id }` | If the token is consumed: create the `accounts` row if the email is new, mint (or return) the `data_key`, mint a `session_token`, claim the login row, return `{ session_token, account: { email, paid, hasVault, dataKey } }`. Else `{ status: "pending" }`. |
| `GET /account/key` | bearer | — | Return the account's `data_key` (minting it if the account predates encryption) — the upgrade path for sessions whose login response carried no key. |
| `DELETE /auth/session` | bearer | — | Revoke this device's session (logout). The client wipes its local state only after this whole flow's final sync is confirmed. |
| `GET /vault` | bearer + pay gate | — | Return `{ blob, version }` for the session's account. |
| `PUT /vault` | bearer + pay gate | `{ blob, version, signPub }` | Upsert if `version` > stored (else `409` + current row to merge). **`signPub` binds once**: first push binds it to the account; a later push with a different `signPub` → `403 identity_mismatch`. On success, wake the account's other devices with a `{t:"vault"}` frame. |
| `POST /history` | bearer + pay gate | `{ blobs: [..] }` | Append client-encrypted chunks to the account's history stream (each gets the next `seq`; ≤64 blobs/push, ≤256 KB/blob). Wakes other devices with `{t:"history"}`. Returns `{ last }`. |
| `GET /history` | bearer + pay gate | `?since=N` | Cursor pull: chunks with `seq > since`, oldest first, pages of 200, plus `last` (the account's newest seq — page again while `cursor < last`). |
| `POST /billing/checkout` | bearer | — | Return the account-tagged payment link (see §6). |
| `POST /billing/webhook` | provider sig | provider event | On paid event, set `accounts.paid=1`. |

Bearer middleware: `sha256(token)` → lookup `sessions` → load `accounts`. Reject
expired; bump `last_seen`.

The vault and history wakes ride the **same push socket** that delivers live
mail (the signPub-keyed inbox Durable Object): the warmer handles tiny
`{t:"mail"|"vault"|"history"}` frames, pulling the vault or history cursor as
needed, and catches up on both at reconnect.

---

## 4. What syncs, and how it's sealed

The vault blob is the account's full state, assembled client-side (`src/vault.ts`):

```jsonc
{
  "identity": { "handle", "name", "boxPub", "boxSec", "signPub", "signSec" },
  "contacts": [ /* full contacts.json incl. tags, evidence, nicknames */ ],
  "settings": { /* tagging mode, requests-only, etc. */ },
  "context": { /* v2: md files, path → content, paths relative to the user dir:
                  "context/threads/<contact>.md" (thread digests) and
                  "context/notes/<topic>.md" (memory notes) */ },
  "v": 2
}
```

**"Sync everything" = the keypair is escrowed too**, so a new device is fully
restored (can open sealed mail and sign as you). Consequence to surface in UX:
**email is the master key** to the whole identity. And since v2, the messenger's
memory rides along: thread digests and `memory_add` notes are **no longer
local-only** — they restore with the account like everything else (reads remain
local).

**At-rest sealing (`src/blob-crypto.ts`).** The client encrypts every blob —
vault and history chunks — with **AES-256-GCM** under the account's 32-byte
`data_key` before pushing. Wire format: `"enc1:" + base64(iv) + ":" +
base64(ciphertext‖tag)`; anything without the prefix is treated as a legacy
plaintext blob, so pre-encryption vaults keep applying after the upgrade. The
key is minted server-side on the account's first login, delivered in the login
poll response, and fetchable via `GET /account/key` for sessions minted before
encryption existed; the device saves it in `session.json`.

**State the trade honestly.** The server stores the ciphertext *and* holds the
key, so this is protection against **DB leaks and dumps**, not against the
server operator — it is **not E2E**. (A passphrase-derived key would be
stronger but breaks pure email-only recovery, which is deliberately the
recovery model. Message transport is unaffected either way — bodies cross the
wire and sit in the mailbox sealed to keys the server never has.)

**Conflict rules.**
- Vault: `PUT` only when `version === stored+1`; on `409`, the client pulls,
  merges (contacts union by `fullKey`, last-write-wins on fields; context files
  local-wins per path; server's identity/settings), re-pushes.
- Identity: **the email's account wins** (§1) — client-side by adopting the
  vault's identity and setting the old dir aside; server-side by the bind-once
  `403 identity_mismatch` rule.

---

## 5. Message-history sync (append-only stream)

Design goal: every device converges on **one complete message history** while
every *read* stays local (`history` tool, `q`/`with`/`before` filters — all
unchanged, all served from the local cache; no read ever hits the server).

Client side (`src/history-sync.ts`):

- **Outbox.** Every message sent or received is appended (best-effort — history
  must never break a send or a drain) to a local JSONL outbox,
  `users/<handle>/history-outbox.jsonl`.
- **Push.** Coalesced background pushes seal the outbox into chunks of ≤200
  rows, encrypt each with the `data_key` (same `enc1:` format), and `POST
  /history`. Pushed rows are dropped from the outbox only after the server
  accepts them; rows appended mid-push survive.
- **Pull.** Each device stores its cursor in `session.json` and pulls past it
  at session start, on `{t:"history"}` wakes, and on reconnect. Message ids are
  globally unique and inserts are `OR IGNORE`, so re-pulling our own chunks (or
  a re-seeded overlap) dedups for free. An undecryptable/malformed chunk is
  skipped rather than wedging the cursor.
- **First-sync backfill.** The first sync **seeds the outbox from the device's
  entire existing local cache**, so conversations from before the account
  existed reach it too. Runs at most once (only when there's no cursor and no
  outbox file); overlap with what another device uploaded dedups on pull.
- **Born read.** Pulled rows land with `read_at` set — history arriving from
  another device is recall material, not new mail, and must never trip the
  inbox hooks. Live surfacing belongs to the device that drained the mailbox;
  **read-state sync is explicitly not built** (future work).

---

## 6. The €1 unlock (built, dormant)

Separate from auth. A one-time charge via a **Stripe Payment Link**:
`POST /billing/checkout` hands back the account-tagged checkout link
(`client_reference_id` = account id); Stripe's webhook hits
`POST /billing/webhook` (signature-verified) → `accounts.paid=1`.

`paid=0` accounts can still `login` (so the flow is testable) but the vault and
history routes return `402 payment_required` with the checkout link — **except
while `FREE_SYNC=1` is set on the Worker (the current state), which waives the
gate entirely.** The billing deps are injected on the Worker and absent on Node,
so tests run without billing.

---

## 7. MCP tools (client)

Thin wrappers over the routes; registered in `src/server-net.ts`. `login` is
the only tool that runs **without** an established account (it's how a device
gets one); everything else returns `no_account` until it succeeds. There is
**no `create_account` tool** — creation is the `need_name` branch of login.

| Tool | Args | Behaviour |
|---|---|---|
| `login` | `{ email?, poll_id?, name? }` | **Two-step.** With `email`: sends the magic link, returns `{ reason:"sent", poll_id }`. With `poll_id`: waits for the click and finishes — restore (`action:"restored"`), bind, or relogin-converge as per §1; `pending`/`expired` as expected. A brand-new email on a fresh device returns `need_name`; call again with the **same `poll_id`** plus `name` to create the account (→ `action:"created"`, with the new handle). Called with **no arguments while logged in**, it converges this device with the server (vault + history round-trip) and reports status (`already_logged_in`: email, pending changes, reachability) — the "am I logged in?" / "sync now" answer. There is no separate sync or status tool: syncing is automatic (session start, debounced pushes after edits/messages, real-time wakes), and this is the manual check-in. |
| `logout` | — | Final vault + history sync, **verified**; any failure aborts with nothing deleted (`sync_failed`). Then `DELETE /auth/session` revokes the bearer token (best-effort), the user dir is wiped, and the device returns to `no_account`. |
| `update_name` | `{ name }` | Update the user's own display name ("call me X") — rewrites `identity.json`, republishes to the handle directory, and dirties the vault. Account, handle, and keys unchanged. |

---

## 8. Integration points (existing code)

- **`src/server-net.ts`** — `login`/`logout` registered outside the guarded
  tool table (they create/destroy the session); every mutating tool marks the
  vault dirty when a session exists.
- **`src/session.ts`** — `session.json`: bearer token, email, `data_key`, vault
  version, history cursor.
- **`src/vault.ts`** — assemble/apply/merge the vault blob (incl. context
  files); **`src/blob-crypto.ts`** — the `enc1:` AES-256-GCM sealing;
  **`src/history-sync.ts`** — outbox, seed, chunked push, cursor pull.
- **`src/warmer.ts`** — session-start sync plus the `{t:"vault"}` /
  `{t:"history"}` wake handlers and reconnect catch-up. Off the user's
  keystroke path; background like the push warmer.
- **`server-mailbox/app.ts`** — routes + bearer middleware (§3);
  **`server-mailbox/schema.sql`** — the five account-layer tables (§2).
- **No change** to the crypto/signature path (`auth.ts`, `canonical.ts`,
  `verify.ts`) or to message sealing.

---

## 9. Infra & free-tier limits

Runs on the existing Cloudflare stack plus **one new dependency**: an outbound
email sender for the magic links (Cloudflare can't send arbitrary email — Email
Routing is inbound-only, and MailChannels' free Workers email ended in 2024).

| Piece | Free tier | First paid step |
|---|---|---|
| Workers (auth/vault/history routes) | 100k requests/**day** (shared with mailbox) | $5/mo → 10M/mo |
| D1 (accounts, sessions, login_tokens, vault, history) | 5 GB · 100k writes/day · 5M reads/day | usage-based, far past free |
| **Email — new** (`Resend`) | 3,000 emails/month | $20/mo → 50k |
| Stripe | €0 fixed | per-transaction fee only |

The auth/sync layer is featherweight: ~1 vault pull at session start + an
occasional push, plus small history pushes per active conversation. It is
**not** what pushes you off free tier. The binding limits, by user count:

- **Email (3k/mo)** — magic-link emails send only on *login* (new device /
  occasional re-auth), never daily. Comfortably **5–10k users**; first €0→$20/mo step.
- **D1 storage** — vaults are small (~5–50 KB + context files); history grows
  with real messaging volume but chunks are compact ciphertext. Not the
  near-term limit.
- **Workers (100k req/day, whole product)** — at ~20–40 req/day per daily-active
  user, **~2,500–5,000 DAU** before Workers Paid ($5/mo) lifts the ceiling ~100×.

The existing push/live-chat WebSocket (Durable Objects) is heavier than anything
auth adds, so if anything moves you to Workers Paid first, it's that — not this.
Email provider is injected (`sendEmail` dep on the Hono app), so it's swappable
and absent in Node tests.
