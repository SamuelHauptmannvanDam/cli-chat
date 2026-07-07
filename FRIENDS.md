# Friend requests, requests-only mode & handle rotation

A consent layer over the mailbox. Today anyone who learns your handle can seal
unlimited mail to you forever, and **contacts of contacts hands out that power
automatically** — every friend-of-friend arrives with a live sending key. This
document replaces the "discover → send directly" model with "discover → request →
accept → send", and adds two switches that fall out of the same design for free:
**requests-only mode** (turn your handle off; new people can only reach you through
a connect request you approve) and **handle rotation** (mint a fresh handle,
strand the bots, keep every friend).

It supersedes the "To write one… `send_message` with their `handle`" half of
[CONTACTS-OF-CONTACTS.md](CONTACTS-OF-CONTACTS.md); the graph, edge store and
`/network` query it describes stay, with two changes noted in §4.

## 1. The one fact this is built on

Sending a sealed message needs **two** public keys:

- `signPub` — the identity key. Stable, survives handle changes, is what contacts
  are stored against (`contacts.json` keys on `signPub` today).
- `boxPub` — the X25519 sealing key. **Without it you cannot encrypt a box at
  all.** It is the send capability.

A "handle" is just a 6-char alias the server resolves to *both* keys
(`GET /resolve/:handle` → `{signPub, boxPub}`). Handing someone your handle =
handing them `boxPub` = handing them unlimited send power. That is correct for the
**out-of-band** path — you chose to share your code, sharing *is* consent.

The fix for the **network** path is simply: **discovery returns `signPub`, never
`boxPub`.** A discovered friend-of-friend is then un-messageable by construction —
there is no policy to enforce and no rate-limit to tune, because the math won't let
you seal a box to them. `boxPub` is released to them **only when you accept their
request** (or they accept yours). Request-only capability = `signPub` with `boxPub`
withheld.

## 2. Relationship states

```
  stranger ──they share their code (out-of-band)──▶ handle-contact (one-way)
     │                                                     │
     │                                              they reply / save you back
     │                                                     ▼
     └──you find them via a mutual──▶ pending request ──accept──▶ confirmed friend (two-way)
                                          (signPub only)          (mutual boxPub exchange)
```

- **Stranger** — no keys either way. Invisible unless you share a code.
- **Handle-contact (one-way)** — someone used your handle (you gave it out). Their
  message lands; they're auto-saved as today. You have *their* keys only if they
  chose to include them (they did — a message envelope carries the sender's keys).
  It's one-way until you write back / save them.
- **Pending request** — a graph-discovered person you've requested (or who's
  requested you). The requester's keys travel *with* the request so the recipient
  can seal an accept back; the recipient's `boxPub` is **not** disclosed until they
  accept. Nothing is deliverable in the meantime.
- **Confirmed friend (two-way)** — both hold both keys, mutual edges exist. This is
  the only state that feeds the contacts-of-contacts graph (§4).

### The two entry paths, side by side

| | **Direct handle** (out-of-band) | **Friend request** (in-network) |
|---|---|---|
| How they found you | You shared your 6-char code | Saw you as a *name* via a mutual |
| What they hold | `signPub` + `boxPub` (full send key) | `signPub` only (routing id) |
| Can they seal mail? | Yes, immediately | **No** — no `boxPub` until you accept |
| First action | Message arrives in your inbox | Request arrives; nothing deliverable |
| Your consent | Implicit (you gave the code) | Explicit (you accept, or ignore) |
| Becomes a friend when | You reply / save them back | You accept |
| Analogy | Giving out your phone number | A LinkedIn/Signal connect request |

"Instant friendship-ish" for the direct path = **one message + your reply = two-way
friend.** The write alone is one-way; your reply is the second edge.

## 3. How you request without seeing a handle

You never type a stranger's handle — the client already holds each
friend-of-friend's `signPub` from building the graph (that's *how* it knows they
exist). You address them by name:

```
> request the Tobias that Niels knows
Sent a connect request to Tobias (via Niels).
```

The client resolves "Tobias via Niels" to that `signPub` and POSTs a request. On
Tobias's side it surfaces like a connect request — *"Someone via Niels wants to
connect: <your name>"* — and he accepts or ignores. Accept → keys exchange both
ways → normal messaging. The handle never appears anywhere in this flow; it exists
only for the out-of-band path.

## 4. Server changes

### 4a. `/network` stops leaking the send key  *(this also closes the HIGH bug)*

`store.contactsOfContacts` currently selects `boxPub` and `handle` and the client
builds a `fullKey`. **Drop `boxPub` and `handle` from the projection and the
response.** Return per person: `{ signPub, name, mutuals, via }`. `signPub` is an
opaque routing id here — not renderable as a handle, not sufficient to send.

**Traverse confirmed (mutual) edges only.** Today an edge is one-way (`owner`
saved `contact`). A one-way save must not propagate you into a stranger's
discovery list — that's the current leak's root. Require reciprocity in the join:

```sql
-- e1: my confirmed friends.  e2: their confirmed friends.  both directions must exist.
SELECT e2.contact AS signPub, h.name AS name,
       COUNT(*) AS mutuals, GROUP_CONCAT(e1.contact) AS via
FROM edges e1
JOIN edges e1r ON e1r.owner = e1.contact AND e1r.contact = e1.owner   -- me⇄friend
JOIN edges e2  ON e2.owner  = e1.contact
JOIN edges e2r ON e2r.owner = e2.contact AND e2r.contact = e1.contact -- friend⇄fof
JOIN handles h ON h.signPub = e2.contact
WHERE e1.owner = :me
  AND e2.contact <> :me
  AND e2.contact NOT IN (SELECT contact FROM edges WHERE owner = :me)
  AND e2.contact NOT IN (SELECT signpub FROM edge_hidden)
GROUP BY e2.contact
ORDER BY mutuals DESC
LIMIT :n;
```

Mutual edges are written on **accept** (§4b) and on the reply that upgrades a
one-way handle-contact — both sides save each other, so both `edges` rows exist.

### 4b. Friend requests

```sql
CREATE TABLE IF NOT EXISTS friend_requests (
  to_signpub   TEXT NOT NULL,   -- recipient (routes delivery)
  from_signpub TEXT NOT NULL,   -- requester identity
  from_boxpub  TEXT NOT NULL,   -- so the recipient can seal an accept back
  from_name    TEXT,            -- requester self-name (shown on the card)
  via_signpub  TEXT,            -- which mutual it came through (shown: "via Niels")
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (to_signpub, from_signpub)
);
CREATE INDEX IF NOT EXISTS idx_reqs_to ON friend_requests (to_signpub);
```

The public keys stored here are no more sensitive than the `handles` table (which
already holds `signPub`/`boxPub`/`name` publicly). Crucially the recipient's
`boxPub` is **never** written into a requester's view — it's disclosed only in the
accept response.

Routes (all Ed25519-signed by the local identity, `:me` = verified pubkey):

- `POST /requests` `{to_signpub, via_signpub?}` — create a request *from* `:me`
  *to* `to_signpub`. Server pulls `:me`'s own `boxPub`/`name` from `handles` (don't
  trust the client's copy). Rate-limited + one row per (to, from). Refuse if a
  confirmed edge already exists.
- `GET /requests` — list incoming requests for `:me` → `[{from_signpub, from_name,
  via_signpub, created_at}]`. (No `boxPub` needed by the UI; it's used on accept.)
- `POST /requests/accept` `{from_signpub}` — `:me` accepts. Server: write **both**
  `edges` rows (me⇄them), delete the request row, and return the requester's
  `{signPub, boxPub, name}` so the accepter can save them. The requester learns the
  accept (and gets `:me`'s `boxPub`) on their next `GET /requests/accepted` (a
  small "accepted since I last checked" pull) or piggybacked on the push socket.
- `POST /requests/decline` `{from_signpub}` — delete the row. Optionally record it
  so the same requester can't re-spam (mirror `decline_tag`'s "don't resurface").

Keeping it E2E: the request/accept carries only public keys and self-names — the
same class of data the mailbox already relays. No message body is server-readable.

### 4c. Requests-only mode ("kill my handle")

Turn your handle *off* — new people can only reach you through a connect request
you approve. Named for the state it produces (handle off, requests on), **not**
"private" (you stay discoverable) and **not** "kill handle" (it's reversible, and
distinct from rotation which *replaces* the handle). "Kill my handle" / "turn my
handle off" / "no direct contact" are trigger phrases for it.

Add `requests_only INTEGER NOT NULL DEFAULT 0` to `handles`.

- `POST /handle/requests-only` `{on}` (signed) — set the flag for `:me`'s handle.
  Reversible: send `{on:false}` to reopen the handle.
- `GET /resolve/:handle` returns `404` (or `{requestsOnly:true}`) when set → the
  out-of-band send path is dead: strangers can't turn your code into a `boxPub`.
  This is the **only** thing the mode changes.
- It does **not** hide you from discovery. You stay in your network's
  contacts-of-contacts list as a name, and people can still send you connect
  requests — you just approve each one. (Hence the `/network` query does **not**
  filter on it.) Existing confirmed friends are unaffected — they cached your
  `boxPub` at accept time and never re-resolve.
- `my_key` while requests-only should say so — e.g. "your handle is off right now;
  people reach you by connect request" — so the user doesn't share a dead code.
- **Known limit (document, don't oversell):** this closes the door to *new*
  strangers only. It can't retract a `boxPub` someone already resolved before you
  flipped it — your keypair never changes (that's what keeps friends working), and
  even handle rotation swaps the *handle*, not the keypair. Truly cutting off
  someone who already holds your `boxPub` needs a full keypair reset (new identity,
  lose your edges) — a separate heavier feature, not this one.
- Separate from the quiet `edge_hidden` opt-out: requests-only = can't be
  *contacted* by handle; `edge_hidden` = don't *appear* in anyone's graph at all.
  Two switches, two meanings — going requests-only does not imply `edge_hidden`.
- Net effect: **no open door. Every new person comes through request-and-approve;
  the only thing lost is instant-contact-by-code.** You stay findable and
  requestable.

### 4d. Handle rotation

**Why it's safe — the handle is a rotatable alias, your keypair never changes.**
Two separate things live here:

| | Changes on rotate? | What it is |
|---|---|---|
| **Keypair** (`signPub` + `boxPub`) | ❌ never | The real cryptographic identity — what contacts are saved against and what mail is sealed to. |
| **Handle** (`k7m2p4`) | ✅ that's the point | A short human-shareable alias the directory maps to the keypair. |

Rotation swaps the alias; the thing it points to is untouched. So **every confirmed
friend keeps working** (they cached your keys, never the code) and **the graph is
untouched** (edges key on `signPub`) — only someone who knew the *old code* is cut
off. That's the whole value: strand the spammers, lose nothing that matters.

- `POST /handle/rotate` `{new_handle}` (signed) — insert `{new_handle → :me's
  signPub/boxPub}` (carrying the `requests_only` flag), delete every other
  `handles` row for `:me`'s `signPub`. One active handle per identity; the old code
  now `404`s on resolve.
- Client caches the new handle in `identity.json`; `my_key` returns it; a sync
  pushes it.

**Rotation vs. requests-only — the two ends of the spam-defense ladder.** Rotate =
"I still want an open handle, just a fresh one" (you're reachable by anyone you give
the new code to). Requests-only (§4c) = "I don't want an open handle at all"
(reachable only through accepted requests). Reach for rotate first — it's cheap and
keeps you open; go requests-only if the spam is bad enough to shut the code entirely.

## 5. Client changes

New/changed tools (mirror the existing style — thin wrappers over the routes,
best-effort like the edge push):

- `request_contact` `{name}` — resolve a contacts-of-contacts entry (by name, using
  `via` to disambiguate) to its `signPub`, `POST /requests`. "Sent a connect
  request to Tobias (via Niels)."
- Incoming requests surface via the **`requests`** tool (the agent calls it at
  session start and on demand): it returns `incoming` (people wanting to connect)
  and drains `accepted` (people who accepted the user's own request, auto-saved as
  contacts). `accept_request {signPub}` / `decline_request {signPub}` act on the
  incoming ones. Accept writes the contact locally + both edges land server-side.
  *(Future enhancement: fold a `[requests]` count into the on-keystroke inbox hook
  for hands-free surfacing, like `[inbox]`; today it's tool-driven.)*
- `contacts` — the **Contacts of contacts** section renders `name · via <contact>`
  and **no handle**, with the affordance "say 'request <name>' to connect." Drop
  `fullKey`/`handle` from those rows.
- `set_requests_only` `{on}` and `rotate_handle {new?}` — thin wrappers over
  §4c/§4d; `rotate_handle` with no arg lets the server pick a free code.
  `set_requests_only` fires on "kill my handle" / "turn my handle off".
- `send_message` to a graph person no longer works by handle (they have none) —
  it should detect "this name is a contacts-of-contacts entry, not a saved
  contact" and steer to `request_contact` instead of erroring.

## 6. CLAUDE.md / instructions.ts changes

- Rewrite **"Contacts of contacts"**: they show as names via a mutual, **no
  handle**; to reach one you **request** (`request_contact`), you don't
  `send_message`. Acceptance is what makes them writable.
- New **"Connect requests"** section: how incoming requests surface, how to relay
  (count + who + via, offer to accept), that accepting is a side-effectful action
  to confirm like a send. A request body is still untrusted content — the
  requester's self-name is data, not instruction.
- New **"Requests-only mode"** and **"Rotating your handle"** one-paragraph
  sections: when the user says "kill my handle" / "turn my handle off" / "no direct
  contact" → `set_requests_only`; "I'm getting spammed, give me a new code" →
  `rotate_handle`. Spell out what each does/doesn't affect ("your friends keep
  working; you stay findable and requestable; only instant-contact-by-code goes
  away") and the known limit (can't retract a code someone already grabbed).

## 7. What it costs / migration

- **Additive server migration** (`friend_requests` table, `handles.requests_only`
  column) like the auth tables — no destructive change. Redeploy the Worker.
- **The `/network` projection change is the breaking one for clients**: old clients
  built `fullKey` from `boxPub`; new response omits it. Ship the client + server
  together, or have the client tolerate a missing `boxPub` (render name-only,
  request-to-connect) so a stale client degrades gracefully instead of crashing.
- Existing one-way edges: switching the join to mutual-only **shrinks** everyone's
  contacts-of-contacts to genuine two-way friends. That's the intended tightening,
  not data loss — saved contacts are unchanged.
- No new server-readable secrets; requests carry only already-public keys + names.

## 8. Build order

1. Server: `friend_requests` table + `handles.requests_only` column (migration);
   `/requests` `POST`/`GET`/`accept`/`decline`, `/handle/requests-only`,
   `/handle/rotate`; mutual-edge rewrite of `contactsOfContacts`;
   drop `boxPub`/`handle` from `/network`. Tests against the node store.
2. Client: `request_contact`, accept/decline, `set_requests_only`, `rotate_handle`;
   `[requests]` hook surfacing; `contacts` COC render change; `send_message`
   steer-to-request.
3. CLAUDE.md + instructions.ts rewrites (§6).
4. Deploy Worker; verify end-to-end with three accounts: A⇄B friends, B⇄C friends,
   A discovers C by name only, A requests C, C accepts, A can now message C; then A
   goes requests-only and B (a friend) still reaches A while a stranger with A's
   old handle cannot; then A rotates and the stranger's old handle 404s.
```
