# Send by email — write anyone, account or not

> **Status: BUILT (2026-07-20).** Server (stubs, /email/resolve, once-ever
> invite, claim-in-login, sweep), client (`send_message` `email` param, contact
> email field, stub adoption on login), agent docs, and integration tests are
> in. Not yet done: deploying the D1 schema + `INVITE_EMAIL_FROM` secret to the
> prod Worker, and the site copy (site updates when the release ships).

## The idea

"write sam@gmail.com: hey" works exactly like "write Sam at AbC123" — an email
address is just another way to address a person. If the email already has an
account, the message delivers normally. If it doesn't, the server provisions a
claimable account for that email, the message waits sealed in its mailbox, and
**one email — ever — tells them something is waiting**. They log in like anyone
else (login is the only front door, unchanged) and everything is already there.

It's all give: the sender reaches anyone, the recipient arrives to a working
account with a real message waiting, and the product's first-run story ("your
first message is the setup") gains its mirror image — *receiving* your first
message is the setup too.

## Why this is sound

- **The email inbox is already the root of trust.** Magic-link login means
  whoever controls the email controls the account. A provisional account
  claimable only by that email is the login flow run in reverse — no new trust
  assumption anywhere.
- **Server-held provisional keys are within the accepted model.** The sync
  vault already stores the account data key server-side (documented tradeoff,
  signed off 2026-07-19 — protection against leaks and dumps, not a strict E2E
  promise). Provisional private keys held until claim are the same exposure
  class. At claim they hand off to the device and are deleted server-side.
- **Provision-on-demand is itself the enumeration defense.** Every email
  resolves to keys — existing account or freshly provisioned, the sender sees
  the identical result ("sent"). Probing an address tells you nothing about
  whether its owner uses cli-chat.
- **The new-handle gate already handles arrival.** To the fresh account the
  sender is a first-time sender, so the waiting message is held behind the
  gate: first boot shows the standard `🆕 Samuel (AbC123) · 1 held` card and
  the recipient decides. Consent model unchanged, nothing new to build.
- **Retention already fits.** The waiting message is ordinary unread mail —
  the existing 30-day unread purge cleans it if never claimed.

## The one-email-ever rule (decided)

A given email address receives **at most ONE notification email from cli-chat,
ever** — sent the first time anyone writes to it. Every later message, from
anyone, accumulates silently. Re-sends never re-notify. No reminders, no
digests, no "still waiting". One email ever is contact, not abuse.

The once-ever marker (`notified_at` on the email row) **survives the 30-day
purge and stub sweep** — if the messages expire and someone writes that address
again years later, no second email goes out. The invite must be genuinely
inert to ignore: ignoring it is the last they ever hear from us.

Invite content: the sender's display name and nothing else — "Samuel Hauptmann
van Dam has a message waiting for you on cli-chat" + the install/login
pointer. Never any message content (it's sealed; we couldn't include it and
wouldn't).

## Flow

### Sender

1. `send_message` grows an `email` param, parallel to `key`:
   "write sam@gmail.com: hey" → `{to: "Sam", body, email: "sam@gmail.com"}` (a bare
   "write sam@gmail.com" uses the mailbox-local part as the name until the user
   gives one).
2. Client calls the new authed route `POST /email/resolve {email}` → the
   mailbox returns `{signPub, boxPub}` — the existing account's keys, or a
   just-provisioned pair. **Same response shape and timing either way.**
3. Client seals to those keys and posts the message exactly like any send,
   saves the contact (name from `to`, email kept on the contact record), and
   returns `saved: true` → the agent renders the ➕ card:
   `↳ 👤 **saved Sam** · sam@gmail.com — "write Sam" works from now on`.
4. Later sends to that contact are ordinary name sends. When the recipient
   claims and mints a handle, the identity (signPub) is unchanged, so the
   saved contact carries over seamlessly; the handle backfills like any
   handle/selfName backfill.

### Server

- **`email_stubs`** (new): `email` (unique), provisional `sign_priv`/`box_priv`
  + publics, `created_at`, `notified_at`. Plaintext email (we must send to it
  and login already stores emails).
- **Provision** (inside `/email/resolve`): no account for the email → mint
  keypair, store stub, register the signPub as deliverable (`isRegistered`
  carve-out: stub signPubs accept mail but hold **no handle** — handles are
  minted at claim, never burned on ghosts). Queue the one invite email iff
  `notified_at` is null; set it.
- **Claim** (inside the existing `login` finish): email matches a stub → the
  normal `need_name` path runs (they're new), then the account is created
  **adopting the stub's keys**, handle minted now, private halves handed to
  the device and deleted from the stub. Waiting mail is simply there —
  drained, gated, announced by the standard paths.
- **Sweep** (existing cron): unread mail purges at 30 days as today. Stubs
  with no waiting mail and no claim purge alongside — **except `notified_at`,
  which is kept forever** (a tiny `email_notified` tombstone row is enough).

### Deliverability

Invites send as **`cli-chat <invite-once@cli-chat.dev>`** (`INVITE_EMAIL_FROM`)
— never from `login@cli-chat.dev`, since magic-link deliverability is
load-bearing. The address itself repeats the promise; it has deliberately **no
Email Routing rule**, so human replies bounce and nothing lands with us —
`feedback@` stays the only address that forwards to a human. Bounces and
delivery failures live in the Resend dashboard as metrics only; a failed invite
send is silently retried on a later resolve (`notified_at` sets only on
success). If invite volume ever warrants it, move the address to its own
verified subdomain — it's just the var.

### Abuse bounds

The one-email-ever rule already caps the mail-cannon: N addresses can be made
to receive at most N emails total, once each, forever. On top:

- `/email/resolve` requires a signed request from a registered sender (same
  auth as every route).
- Per-sender cap on **distinct new provisions** per day (generous — this
  bounds mass-provisioning runs, not normal use).
- Requests-only mode (`update_handle` action `off`) also closes email
  resolution for that account: handle off = email off. It's the recipient's
  one true off-switch, since an email — unlike a handle — can't be rotated
  away.

## Silent save (add-without-send)

`update_contact` (action `add`) also takes an `email` instead of a code: the
contact is saved **keyless and locally only** — no message, no invite, and no
server call at all (the address never leaves the device until the user actually
writes them). The first real send to that name runs the normal resolve path
above, which is also when the once-ever invite fires for a non-user — so the
invite stays tied to a genuine message, never to bookkeeping. The keyless entry
(`pending`) merges into the full contact on that first resolve (nick, tags and
evidence carry over; the user's chosen nick outranks a name derived from the
address). Group sends and verify refuse a still-pending entry with `no_keys` —
write them 1:1 once first.

**Git onboarding** rides on this: `update_contact` action `scan` reads the
working directory's git log **in the MCP server process** (so it works from any
client, shell or not — universal-only rule), returns a cleaned candidate
roster (bots, noreply/dead hosts, own identities, already-saved dropped;
`.mailmap` honoured; same-name addresses merged to the most recent; 12-month
default window), and the agent flow is roster → confirm → silent adds → the
one heads-up offer. A fresh `login` whose working directory has git history
carries the offer in its result note. The scan contacts nobody and never
touches the network.

## What we deliberately do NOT build

- No reminder or follow-up emails, ever (the rule above). This promise is to
  **non-users** — addresses that never joined (`email_stubs`). It is untouched
  by the waiting-mail email (NOTIFY-EMAIL.md), which goes only to **account
  holders** who signed up, defaults on for them, and carries its own opt-out;
  the sweep draws candidates from `accounts` only, so a stub can never receive
  a second email by construction.
- No delivery/read status back to the sender — "sent" is all they ever see
  (also the no-enumeration guarantee).
- No "has this email joined?" query in any form.
- No email addresses in the contacts-of-contacts graph or any directory.

## Agent surface (when built — CLAUDE.md + resultNote homes)

- CLAUDE.md: "Messaging someone by email" section next to the by-key section;
  same ➕ saved card with the email in place of the handle.
- `instructions.ts`: one MESSAGING-BY-EMAIL paragraph.
- `send_message` description: the `email` param + the no-enumeration phrasing
  ("sent" either way; never speculate to the user about whether the address
  has an account).
- `contacts`: render a contact's email where a handle would go while no
  handle exists yet.

## Build order

1. Server: `email_stubs` + `/email/resolve` + invite send + claim-in-login +
   sweep changes. (All behind the existing auth; deployable dark.)
2. Client: `send_message` `email` param, contact email field, backfill on
   claim.
3. Agent docs: CLAUDE.md, instructions.ts, resultNotes (+ e2e notes test).
4. e2e: fresh-email send → invite fires once → second send stays silent →
   claim via login → held card surfaces → purge path.
5. Site: first-run card gets its mirror line only when shipped (docs and site
   describe built state).
