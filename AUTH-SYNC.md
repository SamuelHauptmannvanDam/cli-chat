# Online account: magic-link login + full-state sync

**Goal.** Today an identity is local-only: keypairs, contacts, tags and settings
live under `~/.cli-chat/users/<handle>/` and never leave the device. This adds an
**optional** online account so a user can log in on any device and get their whole
account back — handle, keypair, contacts, tags, settings.

**Trade made (explicit).** This is a **server-custody** feature, not zero-knowledge.
Email is the recovery anchor, so the server can read the synced blob. That's an
accepted trade for a contacts-sync convenience. **Wire confidentiality is
unchanged**: message bodies are still sealed end-to-end to the recipient's box key
(`POST /messages` still stores only ciphertext). Only the *account vault* —
identity + address book — becomes server-readable.

**Unlock.** The billing machinery is a **one-time €1** purchase that flips a
`paid` flag the vault routes require — but it is currently **dormant**: the
Worker runs with `FREE_SYNC=1`, which makes online login/sync free for everyone
(the Stripe checkout/webhook stays wired, just never gates). Flip the env var
off to re-enable the gate. Local-only accounts always work regardless.

**Sync cadence.** Pull at **session start**; push on local mutation (after
`create_account`, `add_contact`, `tag_contact`, settings changes). Last-write-wins
on a `version` counter for v1.

---

## 1. Auth choice: hand-rolled magic link (not Better Auth)

Better Auth is a self-hosted **library** (MIT, runs in our Worker, writes to our
D1 — no SaaS, no per-user billing). It's a fine tool, but its value is *breadth*
(social, passkeys, 2FA, web-cookie/CSRF sessions) — almost all dead weight for a
CLI whose entire auth surface is **one email method**, and whose "session" is a
long-lived device token saved next to the keys, not a browser cookie. So v1 is
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
     │  <─ {session_token} ───────│  (once verified)             │
     │  save session locally      │                              │
```

- `login_token`: short, single-use, ~15 min expiry, **stored hashed** (SHA-256) in
  D1. The emailed link carries the raw token; we only ever compare hashes.
- `poll_id`: opaque id the CLI polls; resolves to a `session_token` once the link
  is clicked. (Avoids the CLI ever seeing the email token.)
- `session_token`: long-lived (e.g. 1 year, renewable), random 32 bytes, stored
  hashed in D1, saved on device as `~/.cli-chat/users/<handle>/session.json`.
  Sent as `Authorization: Bearer <token>` on vault routes.

Rate-limit `login` per email + per IP (reuse the anti-spam shape already in
`server-mailbox/app.ts`). Single-use tokens, constant-time compare on the hash.

### Two request-auth schemes coexist
- **Mailbox routes** (`/messages`, `/mailbox`, `/register`, `/resolve`): unchanged
  — Ed25519 request signatures (`src/auth.ts` + `server-mailbox/verify.ts`).
- **Account routes** (`/auth/*`, `/vault`): bearer `session_token`. New, additive;
  doesn't touch the signature path.

---

## 2. D1 schema additions

Add to `server-mailbox/schema.sql`:

```sql
-- An online account. One row per paying user. Email is the recovery anchor;
-- signPub ties the account to the user's mailbox identity.
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,        -- random account id (uuid-ish)
  email       TEXT NOT NULL UNIQUE,    -- lowercased
  signPub     TEXT,                    -- bound on first sync (handle identity)
  paid        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_signpub ON accounts (signPub);

-- Single-use email login tokens (magic link). Stored hashed.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,        -- sha256(raw token)
  email       TEXT NOT NULL,
  poll_id     TEXT NOT NULL,           -- CLI polls this; never sees token_hash
  consumed_at INTEGER,                 -- null until link clicked
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_poll ON login_tokens (poll_id);

-- Long-lived device sessions. Stored hashed.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,        -- sha256(session token)
  account_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id);

-- The synced account state. One blob per account; opaque to the routes.
CREATE TABLE IF NOT EXISTS vault (
  account_id  TEXT PRIMARY KEY,
  blob        TEXT NOT NULL,           -- JSON (server-readable, see §4)
  version     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

Retention sweep (the existing cron in the Worker): delete `login_tokens` past
`expires_at`, and expired `sessions`.

---

## 3. Worker routes

Add to `server-mailbox/app.ts` (Hono). All return JSON.

| Route | Auth | Body / query | Does |
|---|---|---|---|
| `POST /auth/login` | none (rate-limited) | `{ email }` | Create `login_token` + `poll_id`, email the link, return `{ poll_id, interval, expires_in }`. Creates the `accounts` row if email is new. |
| `GET /auth/verify` | none | `?token=` | User's browser hits this from the email. Validate hash + expiry, set `consumed_at`. Render a "you can return to your terminal" page. |
| `POST /auth/poll` | none | `{ poll_id }` | If the token is consumed: mint a `session_token`, return `{ session_token, account }`. Else `{ status: "pending" }`. Single mint per token. |
| `GET /vault` | bearer | — | Return `{ blob, version }` for the session's account. Requires `paid=1`. |
| `PUT /vault` | bearer | `{ blob, version }` | Upsert if `version` > stored (else `409 conflict` + current). Requires `paid=1`. |
| `POST /billing/checkout` | bearer | — | Return a payment link (see §5). |
| `POST /billing/webhook` | provider sig | provider event | On paid event, set `accounts.paid=1`. |

Bearer middleware: `sha256(token)` → lookup `sessions` → load `accounts`. Reject
expired; bump `last_seen`.

---

## 4. What syncs, and how it's wrapped

The vault blob is the device's account state, assembled client-side:

```jsonc
{
  "identity": { "handle", "name", "boxPub", "boxSec", "signPub", "signSec" },
  "contacts": [ /* full contacts.json incl. tags, evidence, nicknames */ ],
  "settings": { /* tagging mode, etc. */ },
  "v": 1
}
```

**"Sync everything" = the keypair is escrowed too**, so a new device is fully
restored (can open sealed mail and sign as you). Consequence to surface in UX:
**email becomes the master key** to the whole identity.

At-rest storage of `blob` (as shipped): stored as-is; rely on D1/account
isolation + the bearer wall. Server can read it — consistent with the accepted
trade. (A passphrase-derived key would be stronger but breaks pure email-only
recovery, which is deliberately the recovery model.)

Conflict rule: `PUT` only when `version === stored+1`; on `409`, client pulls,
merges (contacts union by `fullKey`, last-write-wins on fields), re-pushes.

---

## 5. The €1 unlock (built, dormant)

Separate from auth. A one-time charge via a **Stripe Payment Link**:
`POST /billing/checkout` hands back the account-tagged checkout link
(`client_reference_id` = account id); Stripe's webhook hits
`POST /billing/webhook` (signature-verified) → `accounts.paid=1`.

`paid=0` accounts can still `login` (so the flow is testable) but `GET/PUT /vault`
return `402 payment_required` with the checkout link — **except while
`FREE_SYNC=1` is set on the Worker (the current state), which waives the gate
entirely.** The billing deps are injected on the Worker and absent on Node, so
tests run without billing.

---

## 6. New MCP tools (client)

Thin wrappers over the routes; mirror the existing tool style in `src/server-net.ts`.

| Tool | Args | Behaviour |
|---|---|---|
| `login` | `{ email }` | Calls `/auth/login`, prints "Check your email — I'll wait." Polls `/auth/poll` (respect `interval`) until a `session_token` comes back; saves `session.json`. If the paid gate is active and `paid=0`, surfaces the €1 checkout link. On a fresh machine, a successful login restores the account locally. |
| `sync` | — | Pull `/vault`; if newer than local, write identity/contacts/settings. Then push local if changed. Called automatically at session start (see §7). Manual `sync` forces a round-trip. |
| `account_status` | — | Show email, paid state, last sync, version. |

`login`/`sync` must handle the bootstrap case: on a fresh device there's no
identity yet, so `sync` **creates** `~/.cli-chat/users/<handle>/` from the pulled
vault (writes `identity.json`, `contacts.json`, `settings.json`, sets `/current`).

---

## 7. Integration points (existing code)

- **`src/server-net.ts`** — register the new tools; reuse `mailbox-client.ts` for
  HTTP. Add a small `session.ts` (load/save `session.json`, attach bearer header).
- **Session-start sync** — the cheapest hook in: have the **warmer** (`src/warmer.ts`)
  or the SessionStart path call `sync` once if a `session.json` exists. Keep it
  off the user's keystroke path; it's a background pull like the push warmer.
- **`src/contacts.ts` / `src/add-contact.ts` / tag writes** — after a local
  mutation, mark the account dirty (bump local `version`) so the next `sync`
  pushes. A simple `vault-dirty` flag file under the user dir avoids diffing.
- **`server-mailbox/app.ts`** — add routes + bearer middleware; reuse the
  rate-limit helpers already there for `/auth/login`.
- **`server-mailbox/schema.sql`** — the four new tables (§2).
- **`paths.ts`** — add `session.json`, `vault-dirty` path helpers.
- **No change** to the crypto/signature path (`auth.ts`, `canonical.ts`,
  `verify.ts`) or to message sealing.

---

## 8. Infra & free-tier limits

Runs on the existing Cloudflare stack plus **one new dependency**: an outbound
email sender for the magic links (Cloudflare can't send arbitrary email — Email
Routing is inbound-only, and MailChannels' free Workers email ended in 2024).

| Piece | Free tier | First paid step |
|---|---|---|
| Workers (auth/vault routes) | 100k requests/**day** (shared with mailbox) | $5/mo → 10M/mo |
| D1 (accounts, sessions, login_tokens, vault) | 5 GB · 100k writes/day · 5M reads/day | usage-based, far past free |
| **Email — new** (`Resend`) | 3,000 emails/month | $20/mo → 50k |
| Stripe | €0 fixed | per-transaction fee only |

The auth/sync layer is featherweight: ~1 vault pull at session start + an
occasional push, ~1–3 extra requests per user per day. It is **not** what pushes
you off free tier. The binding limits, by user count:

- **Email (3k/mo)** — magic-link emails send only on *login* (new device / occasional
  re-auth), never daily. Comfortably **5–10k users**; first €0→$20/mo step.
- **D1 storage** — each vault ~5–50 KB → **~100k users** in 5 GB. Not the limit.
- **Workers (100k req/day, whole product)** — at ~20–40 req/day per daily-active
  user, **~2,500–5,000 DAU** before Workers Paid ($5/mo) lifts the ceiling ~100×.

The existing push/live-chat WebSocket (Durable Objects) is heavier than anything
auth adds, so if anything moves you to Workers Paid first, it's that — not this.
Email provider is injected (`sendEmail` dep on the Hono app), so it's swappable
and absent in Node tests.
