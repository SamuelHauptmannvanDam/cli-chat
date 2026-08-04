# Waiting-mail email — "you have mail" after ~24h offline

> **Status: BUILT (2026-07-21, 0.23.0).** Server (schema columns, sweep,
> drain re-arm, opt-out route), worker cron branch, client (`update_notify`
> `channel:"email"`, settings mirror), agent docs, and tests are in. Not yet
> done: the two remote `ALTER TABLE accounts` commands + the hourly cron /
> `NOTIFY_EMAIL_FROM` deploy to the prod Worker, and the `notify@cli-chat.dev`
> sender in Resend.

## The idea

cli-chat lives in a terminal, so mail can wait invisibly: if no device of yours
comes online, nothing on your desk tells you someone wrote. The waiting-mail
email is the net under that gap — when a message has sat on the server for 24
hours with **no device of yours having fetched it**, the server emails your
account address: "you have N messages waiting, from Alice and Bob." Counts and
sender display names only; bodies are sealed ciphertext the server couldn't
include and wouldn't. It complements desktop notifications (0.22.0), which
cover the machine-on case — this covers the machine-off one.

"Read" is deliberately not the trigger: read state lives only in the local
cache and is never reported to the server. The server's one honest signal is
`fetched_at IS NULL` — *no device online since the message arrived* — which is
exactly the "user is away" condition the email is for.

## Once per away-stretch (the anti-nag rule)

One absence gets **at most one email**. The state machine is a single column,
`accounts.unread_notified_at`:

- **Sweep** (hourly cron): an account qualifies when its `signPub` is bound,
  `unread_emails = 1`, `unread_notified_at IS NULL`, and ≥1 unfetched message
  has `received_at < now − 24h` (server receive time — the sender-controlled
  `created_at` is never trusted). Self-sends (sender = recipient) never count.
  Send first, mark `unread_notified_at` only on success (a failed send retries
  next hour — the invite pattern).
- **Drain** (`GET /messages`): clears the marker — the user came online, so the
  next absence is a fresh away-stretch. Even an empty drain proves presence
  (another device may have drained first). Best-effort; never blocks a drain.
- If the user stays away, the marker stays set: no second email, ever, for
  that stretch. `max(fetched_at)` was rejected as the "last online" signal —
  the 7-day purge of fetched rows erases drain evidence and would have
  permanently muted users.

The email reports **everything** waiting (count + names), not just what aged
past 24h — the user is away either way. Copy states the honest limits: mail
waits up to 30 days (the retention truth), one email per absence, and the
opt-out phrasing.

## Who gets it (and who never does)

Only **account holders** — recipients with an `accounts` row whose `signPub` is
bound and whose email is therefore known server-side. Non-users someone wrote
by address (`email_stubs`) are excluded **by construction**: the sweep draws
candidates from `accounts` only, so EMAIL-SEND.md's one-invite-ever promise to
non-users stands untouched. Identities that never logged in have no server-known
email and simply can't be notified.

## Opt-out (server-readable by necessity)

The sweep runs while every device is offline, so a local/vault setting could
never stop it — the flag is a server-readable column, `accounts.unread_emails`
(default 1), flipped by the signed route `POST /account/unread-emails` (the
`/handle/requests-only` pattern). Client surface: the existing `update_notify`
tool grew an optional `channel` — `"desktop"` (default, unchanged) or
`"email"`. "stop emailing me about waiting mail" → `{channel:"email",
action:"off"}`. The toggle needs a logged-in account and the network (the
server is the source of truth; a failed toggle reports, never lies).
`settings.emailNotify` mirrors the last toggle locally so `status` answers
without a round-trip, and rides the vault like the rest of settings.

## Pieces

- `server-mailbox/schema.sql` — `accounts.unread_notified_at`,
  `accounts.unread_emails` (+ one-off `ALTER TABLE` upgrade comments).
- `server-mailbox/store.ts` / `store-d1.ts` — `unreadEmailCandidates`,
  `markUnreadNotified`, `clearUnreadNotified`, `setUnreadEmails`.
- `server-mailbox/unread-sweep.ts` — `sweepUnreadEmails` (24h age, 50/run cap;
  overflow re-qualifies next hour, so the cap defers, never drops).
- `server-mailbox/email.ts` — `unreadEmail` builder (names deduped, ≤3 shown,
  HTML-escaped — they're sender-chosen and untrusted).
- `server-mailbox/app.ts` — drain re-arm + the opt-out route.
- `server-mailbox/worker.ts` — `scheduled()` branches on the cron string:
  `"0 3 * * *"` retention (unchanged), `"0 * * * *"` the sweep. Sender
  identity `NOTIFY_EMAIL_FROM` (own address, no Email Routing rule — same
  bounce-isolation stance as `invite-once@`), falling back to
  `INVITE_EMAIL_FROM`.
- Client: `mailbox-client.ts` `setUnreadEmails`, `settings.ts` `emailNotify`,
  `server-net.ts` `update_notify` channel + `setEmailNotify`.
- Tests: `test/integration/unread-email.test.ts` (sweep rules, away-stretch
  cycle over signed HTTP, stub-exclusion promise, escaping),
  `store-d1.test.ts` parity, `settings.test.ts` defaults.

## Deploy notes

Order matters: run the two `ALTER TABLE accounts …` commands against remote D1
FIRST (harmless to the running old code), then `npx wrangler deploy` from the
repo root — the new SQL references columns that otherwise don't exist. Add the
`notify@cli-chat.dev` sender in Resend before or with the deploy (cli-chat.dev
is already verified; no new domain setup). Resend free tier is 100 emails/day —
the 50/run cap is comfortable at current scale; raise the plan before the cap.
