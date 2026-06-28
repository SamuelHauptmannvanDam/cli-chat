# Headless CLI Messenger — Concept & Plan

> A peer-to-peer messaging layer for CLI agents. You tell your agent "write Niels,"
> it resolves who Niels is from your contact book, and delivers the message to his
> agent. When Niels opens his CLI, his agent notices a pending message, offers to
> read it, drafts a reply, and — when the message needs real input ("let's plan a
> LAN, when are you free?") — actively asks him for the missing facts and answers
> on his behalf.

---

## 1. The vision (in plain terms)

- **Send by name, not by address.** "Write Niels" → the agent looks at your contacts,
  picks the most likely Niels, and sends.
- **Headless delivery.** Messages travel agent-to-agent. No app open required on the
  sender's side; the recipient's agent picks them up whenever their CLI is next active.
- **Proactive inbox.** The MCP exposes a `messages_available` signal. When the recipient
  opens their CLI, the agent says "you have a message from Sam, want me to read it?"
- **Drafted, grounded replies.** The agent reads the message, understands intent, and
  drafts a reply. If the reply needs information it doesn't have ("when are you
  available?"), it *asks the human* and returns with the real answer (e.g. your free days).
- **Fuzzy contact resolution across the social graph.** "Write Tobias" but you have no
  Tobias → search friends-of-contacts. "There's a Tobias connected to Niels — is that
  who you mean?"
- **Learned metadata over time.** As you message people, the system attaches meta tags
  (shared company, mutual contacts, context) so future resolution gets sharper. Tagging
  happens on-send, using your tokens, encrypted, with relevant tags traveling alongside.

---

## 2. Core components

| Component | Responsibility |
|---|---|
| **Contact resolver** | Map a name → a specific contact, using local book + social graph + learned tags. Handles ambiguity and "did you mean X connected to Y?" prompts. |
| **MCP transport** | The skill/tool surface each user runs. Exposes `send_message`, `messages_available`, `read_message`, `draft_reply`. The `messages_available` flag is what makes the inbox proactive. |
| **Message store / relay** | Holds messages until the recipient's agent fetches them. Could be a relay server or a P2P/mailbox model. End-to-end encrypted. |
| **Reply engine** | Reads inbound message, classifies intent, drafts a reply, and detects when it must ask the human for missing facts (availability, decisions). |
| **Tagging / graph builder** | On every interaction, extracts and stores meta tags (company, mutual friends, topic) to improve future resolution. |
| **Identity & keys** | Each user has an identity + keypair. Messages encrypted to the recipient; tags signed/encrypted too. |

---

## 3. Key flows

### 3.1 Send by name
1. User: "write Niels: yo let's plan a LAN."
2. Resolver finds candidate "Niels" in contacts (disambiguates if >1).
3. `send_message(to: niels_id, body: <encrypted>, tags: [company, mutuals, topic=LAN])`.
4. Message lands in Niels's mailbox.

### 3.2 Proactive receive
1. Niels opens his CLI; MCP `messages_available` returns `true`.
2. Agent: "You have a message from Sam — want me to read it?"
3. On yes → `read_message` → "Sam wants to plan a LAN and asks when you're free."
4. Agent drafts reply; sees it needs Niels's availability → asks Niels.
5. Niels answers ("Sat + Sun next week"); agent sends grounded reply back to Sam.

### 3.3 Fuzzy resolution across the graph
1. User: "write Tobias."
2. No local "Tobias." Resolver searches friends' contacts (shared-graph lookup).
3. Finds "Tobias connected to Niels."
4. Agent: "You don't have a Tobias. There's a Tobias connected to Niels — write him?"

### 3.4 Learned tagging
- On send/receive, extract context (company, mutual contacts, recurring topics).
- Encrypt + attach as tags so future "which Tobias?" questions resolve confidently.

---

## 4. Open questions / decisions to make

1. **Transport model** — central relay vs. P2P/mailbox vs. existing protocol (Matrix,
   Signal-style, Nostr-style relays)?
2. **Identity** — how do two users discover and trust each other's keys / agent endpoints?
3. **Graph sharing** — "search a friend's contacts" implies some shared/queryable graph.
   What's exposed, and with what consent/privacy boundary? *(Proposed answer:
   mutual-top-tier reciprocity — you traverse someone's contacts only if you're
   each in the other's top ~125. See Phase 3.)*
4. **Where the MCP runs** — always-on daemon vs. only-when-CLI-open. The proactive
   `messages_available` needs *something* to be reachable, or a fetch-on-open model.
5. **Consent on auto-reply** — how much can the agent send without explicit confirmation?
6. **Encryption scope** — bodies E2E encrypted; what about tags (needed for routing/
   resolution but also sensitive)?
7. **Spam / abuse** — open "message anyone by name" is a spam vector; what gates it?

---

## 5. Suggested first milestone (thin vertical slice)

A minimal end-to-end loop between two local users:
1. MCP server with `send_message` + `messages_available` + `read_message`.
2. A flat local contact book (JSON) + exact-name resolver (no graph yet).
3. A file/SQLite mailbox as the relay (single machine or shared folder first).
4. Agent prompt that, on CLI open, checks `messages_available` and offers to read.
5. One round-trip: Sam → Niels → drafted reply asking Niels for input → reply back.

Defer until the slice works: social-graph fuzzy resolution, encryption, learned tags,
remote transport.

---

## 6. Hosting & backend architecture

**Key insight: almost nothing needs to be hosted.** The MCP server runs locally on each
user's machine, contacts live locally, and message bodies are end-to-end encrypted. The
only hosted component is a **dumb store-and-forward mailbox** — it holds encrypted blobs
until the recipient fetches them and never sees plaintext. It's a mailbox, not a brain.

### What the hosted piece does
1. Accept an encrypted message for recipient X → store it.
2. Answer "any messages for me since timestamp T?" → this powers `messages_available`.
3. Hand over the blobs → recipient's agent decrypts locally.
4. Authenticate callers by **signed request** (each user has a keypair; sign a challenge).
   Server stores opaque ciphertext keyed by recipient pubkey.

For the MVP, use **fetch-on-open (polling)**, not push. When the CLI opens, the agent calls
`GET /mailbox?since=T`.

### Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript / Node** | Same language as the MCP server — share the message/tag schema across client and server. |
| HTTP framework | **Hono** | Tiny, fast, runs on *both* Node containers and Cloudflare Workers — hosting choice stays reversible. |
| Storage | **SQLite** (libSQL/Turso or Cloudflare D1) | A mailbox is just `(recipient, blob, created_at)`. Postgres only if outgrown. |
| Hosting | **Cloudflare Workers + D1** (recommended) | Scales to zero, global edge, Durable Objects give a clean path to push later. |
| Crypto | **libsodium** | Sealed boxes for E2E, signatures for auth. Don't write our own crypto. |

**The one real fork — serverless vs. container:**
- **Cloudflare Workers + D1** — recommended. Cheapest at low volume, no servers to babysit,
  Durable Objects host per-user mailbox state + future push.
- **Fly.io / Railway + Postgres + Node container** — pick if we'd rather have a normal
  always-on process to SSH into, run background jobs, debug conventionally. More ops.

Because everything sits on Hono, we can switch hosting without a rewrite.

**Alternative — no infra at all:** bootstrap transport on **Nostr relays** (public
store-and-forward for signed/encrypted events). Faster start, zero hosting, but less
control and a model we don't own. Only if "run no infra" is a hard requirement.

### Mailbox schema (MVP)
```
messages(
  id           text primary key,   -- uuid
  recipient    text not null,      -- recipient pubkey
  sender       text not null,      -- sender pubkey
  body         blob not null,      -- libsodium sealed ciphertext
  tags         blob,               -- encrypted meta tags
  created_at   integer not null,   -- unix ms
  fetched_at   integer             -- null until pulled
)
```

### API surface (MVP)
- `POST /messages` — send. Body: `{recipient, sender, body, tags, sig}`. Server verifies sig, stores.
- `GET  /mailbox?since=T` — `messages_available`. Returns count + ids for the authed pubkey.
- `GET  /messages?since=T` — pull the encrypted blobs; marks `fetched_at`.

### Not building yet
- The social graph / "search a friend's contacts" — the one feature that pulls toward a
  smarter, more privacy-fraught server. Out of v1.

### Capacity & scaling (analysed 2026-06-21)

**The bottleneck is D1 writes.** The Worker edge auto-scales and the per-recipient
push DOs shard naturally — neither caps us. Everything funnels through one shared D1
database, and SQLite is single-writer, so total throughput is bounded by that one
database's write rate.

**Cost per message ≈ 3 row-writes:** `INSERT` on send + mark-read on drain + the
eventual retention `DELETE`. (Cloudflare bills *rows written*, not statements — so
batching the drain into one `UPDATE … RETURNING` is a correctness/subrequest win, **not**
a capacity one. The `known`-ledger insert is `INSERT OR IGNORE`, ~free after first
contact.) Reads are plentiful and never bind.

At **10 messages/day/user** (≈25–30 row-writes/user/day):

| Tier | Limiting factor | Users @ 10 msg/day |
|---|---|---|
| **Free** | 100k rows-written/day (Workers 100k req/day is similar) | **~3,000–5,000** |
| **Paid ($5/mo), within included bundles** | 10M req/mo (~333k/day) binds before the 50M writes/mo bundle | **~20,000** (soft — overage is cheap) |
| **Hard architectural ceiling** | single shared D1, writes serialised at peak | **~50,000–100,000** |

The first two rows are *billing* limits (you pay past them). The third is the real wall and
is plan-independent.

**Levers (in priority order):**
1. **Batch the drain** — ✅ done (0.4.8). Atomic `UPDATE … RETURNING`; robustness + stays
   under the Workers 50-subrequest cap on large drains. No capacity change.
2. **Delete-on-drain** — ❌ rejected. Would cut a write/message (free → ~5–7.5k) but the
   admission filter counts message rows in the 1-hour window; deleting on drain lets a
   flooder past any actively-draining (watch-mode) recipient. The write you'd save is
   re-spent on separate spam bookkeeping anyway, so the gain is illusory once the throttle
   is preserved.
3. **Shard storage into the per-recipient Inbox DO** — the path past ~100k. The DO already
   exists per user and has its own SQLite, so writes would shard per recipient and the
   shared-D1 wall disappears. Big change: splits the data model (the handle directory stays
   global), reimplements the store as DO RPC, moves retention to DO alarms, and loses the
   local `node:sqlite` test path (needs workerd/Miniflare). Defer until actually near the wall.

*Caveats:* estimates from architecture + published limits, not load tests. D1's sustained
write QPS isn't a hard published number (treat ~50–100k as an order of magnitude), and
DO-SQLite free allotments are assumed ~same order as D1 — confirm against current Cloudflare
pricing before betting on a number.

---

## 7. Decisions (locked 2026-06-12)

- **Hosting: Cloudflare Workers + D1.** Scales to zero, edge, Durable Objects reserved for
  future push. Build on Hono so the choice stays reversible.
- **Inbox signal: poll on CLI open.** No persistent connection in v1. `messages_available`
  is a `GET /mailbox?since=T` the agent runs when the CLI starts. Push is a later phase.
- **Scope: build the thinnest slice first** — but document the full future as we go
  (see roadmap below). Thin to ship, complete on paper.

## 8. Phased roadmap

> Principle: each phase ships something usable; nothing in the long-term vision is dropped,
> just deferred and written down.

### Phase 0 — Thinnest local loop (build now)
- Two users on one machine (or shared folder). Local JSON contact book, exact-name resolver.
- SQLite mailbox file as the relay (no network yet). No encryption yet.
- MCP server exposing `send_message`, `messages_available`, `read_message`, `draft_reply`.
- Agent prompt: on CLI open, poll `messages_available`, offer to read, draft a reply, and
  ask the human when the reply needs missing facts ("when are you free?").
- **Goal:** prove Sam → Niels → drafted reply asking for input → reply back.

### Phase 1 — Networked + encrypted  ✅ BUILT (2026-06-15)
- Hono mailbox app (`server-mailbox/`) with `POST /messages` / `GET /mailbox` /
  `GET /messages`, store-and-forward of encrypted blobs only. Runs on Node
  (`node:sqlite`, verified) and on Cloudflare Workers + D1 (`worker.ts` +
  `wrangler.toml`, deploy-ready, not yet pushed).
- Identity keypairs (Ed25519 address + X25519 box) via libsodium; sealed-box E2E
  on bodies; signed-request auth (sender spoofing rejected, stale requests
  rejected). `src/setup-identities.ts` bootstraps keys + exchanges public keys.
- Client (`src/core-net.ts`) seals on send, drains + decrypts into a local inbox
  cache so read/preview keep their Phase 0 feel. MCP server: `src/server-net.ts`.
- Verified by `npm run test:e2e` (in-process) and `npm run test:mcp` (real
  MCP processes + running mailbox). (Scripts since renamed from `test:net`/`test:net:mcp`.)
- **DEPLOYED LIVE** (2026-06-15) to Cloudflare Workers + D1:
  `https://mailbox.cli-chat-mcp.workers.dev`. Full
  encrypted round-trip verified against the public URL.
- **Crypto split (Workers constraint):** Workers forbids runtime
  `WebAssembly.instantiate`, so libsodium (WASM) can't run server-side. The
  *server* verifies Ed25519 with native WebCrypto (`server-mailbox/verify.ts`,
  runs on both Workers and Node); the *client* keeps libsodium for sealed boxes
  + signing. Canonical signing bytes are shared (`src/canonical.ts`).

### Cross-CLI + short codes — ADDED (2026-06-16)
- **Works on any MCP-capable CLI** (Claude Code, Gemini CLI, Codex CLI, Cursor, …),
  not just Claude Code. Agent behavior travels in the server's MCP `instructions`
  (sent on connect), so no per-CLI prompt file is required. `src/install.ts`
  detects installed CLIs and writes each one's MCP config; portable "check on
  first turn" replaces the Claude-only SessionStart hook on other CLIs.
- **6-character handles** via a server registry (`POST /register`, `GET /resolve`):
  share a short code instead of a long key; `send_message`/`add_contact` resolve
  it. Trade-off: handle→key lookup trusts the (self-hosted) server.
- **Background auto-delivery watcher** (`enable_auto_delivery` tool /
  `src/watch.ts`): **Removed (2026-06-20)** — a separate long-lived per-OS
  process was more moving parts than it was worth versus poll-on-open. Replaced
  by the in-session `watch` tool (a long-poll loop the agent re-calls), which
  needs no OS service and works in any MCP CLI. Dropped the
  `enable_auto_delivery`/`disable_auto_delivery`/`delivery_status` tools and
  `src/watch.ts`. (The `watch` tool was itself removed 2026-06-27 in favour of the
  live `chat` inbox — the `await-mail` waker + `chat_batch`.)
- **Cleanup (2026-06-16):** removed the superseded Phase 0 local stack
  (`server.ts`, `core.ts`, `config.ts`, `setup-identities.ts`, `AGENT.md`,
  `test/roundtrip.ts`, `test/live.ts`). Stack is Node/TS throughout.

### Phase 2 — Smarter resolution & learned tags
- **Phase 2a — local auto-tagging & tag-based group send is the ACTIVE focus.**
  Detailed plan in §9 below. Ship this first; it's purely local (no server change,
  no privacy fork).
- Encrypted meta tags on send (company, mutual contacts, topic) — §3.4. *(The
  cross-agent / network-resolution flavour of tags; deferred behind 2a.)*
- Disambiguation when >1 candidate for a name.
- Tagging improves future "which Tobias?" confidence.

### Phase 2.5 — Relationship tiers (Dunbar layers)
- Give each contact a **closeness tier** using the classic Dunbar layers — ~5
  (inner clique) / 15 (close) / 50 (meaningful) / 150 (the outer "who you'd
  recognise and stay in touch with" circle; we use **125** as the working cap).
- **Explicit vs. inferred** is the design fork. Lean inferred-first: rank from
  interaction history (frequency + recency + reciprocity), which we already have
  the raw signal for — sends are observable, and the `received_at` column added
  for spam admission is a ready clock. Let the user pin/override a few by hand
  (their inner five), but don't make them sort 125 people.
- A `Contact.tier` (or a derived score) is the one new field; everything below
  reads it.
- **What tiers unlock:**
  - *Resolution tie-break* — "which Sam?" prefers a closer-tier Sam (feeds Phase
    2 disambiguation).
  - *Notification scope* — real-time `watch`/push for the inner tiers, quiet
    on-keystroke for the long tail.
  - *Spam admission* (already built) — auto-promote inner-tier contacts to
    "known"; apply softer caps to known-but-distant ones. See open Q #7.

### Phase 3 — Social-graph fuzzy resolution (mutual-top-tier gated)
- "Write Lars" with no local Lars → look through **my network** for a Lars and
  offer the best match: "You don't have a Lars. Niels has a Lars Andersen —
  write him?" (§3.3). This is the feature that makes a flat address book feel
  like a graph.
- **Consent boundary (answers open Q #3): mutual-top-tier reciprocity.** You can
  see/traverse someone's contacts only when **you are each in the other's top
  ~125** — a symmetric, opt-in-by-relationship gate, not an open directory. No
  one-way scraping: if Niels isn't in your circle (or you aren't in his), his
  contacts stay invisible. Within that gate, discovery still respects the spam
  caps (a found stranger is an *unknown* sender — first contact is a throttled
  request, never a free channel).
- **Full names are load-bearing here.** Network lookup matches a typed "Lars"
  against contacts' names, so the self-introduced name that propagates between
  agents should be a real full name — hence we ask the user for their full name
  at setup. ("Your nick wins" still holds: I can locally call Lars Andersen
  "Lars" while the graph knows his full name.)
- Still the privacy-heaviest feature — settle the exact query mechanism before
  building: does the server answer "any Lars in my top-tier's books?" (it would
  then learn graph edges), or is it a signed peer-to-peer/encrypted query that
  keeps the server blind? Decide the metadata trade-off explicitly.
- This phase depends on **Phase 2.5** (tiers must exist to gate on them).

### Phase 4 — Real-time push
- Durable Objects + WebSocket so messages surface while the CLI is already idle-open.
- Replaces poll-on-open as the primary signal; polling stays as fallback.

### Cross-cutting, tracked but unscheduled
- Spam/abuse gating on "message anyone by name" (open Q #7). **Largely landed**
  as layered defense for a public launch:
  - **New-sender admission** (`app.ts` + the `known` ledger). A sender the
    recipient has never written to is "unknown" and bounded by three caps:
    per-`(sender→recipient)` pair / hour (one stranger can't flood one inbox),
    per-recipient / hour across all unknown senders (the Sybil backstop — fresh
    keys are free, so this key-independent ceiling is the real wall), and
    per-sender / day of *cold* outreach (bounds one identity's total spray
    across the whole network — the thing the per-recipient caps can't see).
    Replying makes a sender "known" and exempt; all counts use the server's
    receive clock so created_at can't be back-dated to dodge the window. Tunable
    via `MAILBOX_UNKNOWN_PAIR_HOURLY` / `_RECIPIENT_HOURLY` / `_SENDER_DAILY`.
  - **Edge rate limits** (Cloudflare Rate Limiting bindings, `worker.ts` +
    `wrangler.toml`): per-IP on `/resolve` (caps directory harvesting — the step
    that would let an attacker build a whole-network target list), and per-IP +
    per-sender-key on `POST /messages` (caps the raw flood / cost-DoS before the
    admission logic runs). The app injects an optional limiter and **fails open**,
    so the Node/dev path is unaffected.
  - Still open: explicit block/mute, handle rotation (burn a leaked code), and
    the structural upgrade — surfacing unknown mail as an accept/ignore
    **request** the recipient must approve, rather than throttle-but-deliver.
- Key discovery & trust between users (open Q #2).
- Consent boundaries on what the agent may auto-send (open Q #5).

---

## 9. Auto-tagging & tag-based group send (Phase 2a — active focus, planned 2026-06-28)

> **The pitch.** Over time, the agent learns *who's who* from your conversations and
> tags people locally — "work", "family", "LAN crew". Eventually you say **"write
> everyone from work"** and the agent answers **"I've tagged Niels, Tobias and Mette
> as coworkers — write all three?"**, confirms the roster, and fans the message out.
> Tags also sharpen ordinary resolution and disambiguation down the line.

### Why this one now
- **100% local. No server change, no privacy fork.** Tags live in your own contact
  book; nothing about them ever touches the mailbox or the directory. This is the
  opposite of friend-of-friend (§3.3 / parked) — all upside, none of the graph-exposure
  debate. That's exactly why it's the right next build.
- It reuses signal we already have: the agent already reads message bodies when it
  relays/replies, so inference happens on tokens we're already spending — no new
  background cost.

### Data model (local only)
- Add to `Contact` (`src/contacts.ts`): `tags?: string[]` — confirmed labels,
  lower-cased + trimmed, deduped. Never serialised into a message envelope; never
  sent to the server.
- Keep v1 deliberately flat (just `string[]`). If we later need provenance
  (manual vs inferred) or confidence for trust/inference, add a parallel
  `tagMeta?: { tag: string; source: "manual" | "inferred"; addedAt: number }[]`
  — but don't build it until 2a-iii needs it.
- Tag strings are freeform; the **agent** normalises synonyms at write time
  ("coworker"/"from work"/"office" → `work`). No fixed taxonomy.

### Where tags come from — three escalating layers
1. **Manual (2a-i).** "tag Niels as work", "Niels is from work", "they're family."
   Agent calls `tag_contact`. Trivial, fully in the user's control.
2. **Agent-suggested from conversation (2a-ii) — the "auto" magic.** While relaying
   or replying, the agent notices signals in the *body* it's already reading
   (shared employer, standup/sprint/deploy/PR talk → `work`; LAN/game/raid →
   `gaming`; mum/dinner/birthday → `family`) and **suggests** a tag:
   "Sounds like Niels is a coworker — tag him as `work`?" Applied only on a yes.
3. **Cross-contact inference (2a-iii).** Once some people are tagged, the agent can
   spot that an *untagged* contact shares the same context ("Tobias keeps mentioning
   the same standup as Niels — also `work`?") and suggest it. Needs the richer
   `tagMeta`/signal store; furthest out.

### When it runs (cadence)
**Not scheduled or polled — there's no background process.** The agent only runs
during turns, so tagging rides on message-handling turns that already happen, as a
side-effect with no extra model call:
- **On reading/relaying inbound mail** — the agent is already parsing the body to
  summarise it; it notes tag signals in the same pass.
- **On sending** — the outbound body carries context too.

So cadence ≈ **once per message handled**, never while idle. Two things keep it
cheap and quiet:
- **It converges.** Once a contact carries a tag, don't re-derive it on every future
  message — so after the first hit most messages produce no tagging work at all.
- **Cross-contact inference (2a-iii) is metered separately.** Comparing an untagged
  contact against the tagged ones is heavier than reading one body, so it should NOT
  run per-message — trigger it occasionally (e.g. when a new untagged contact first
  becomes active), not every turn. The per-message layers (2a-i/ii) stay the cheap
  default.

### Confirmation discipline (the trust rule)
- **Tagging is auto by default** (see setting below). Because a tag is local,
  private, and trivially reversible (`untag_contact`), the agent applies an obvious
  tag silently — it doesn't ask first. It should still *mention* notable tags it
  applies in passing ("tagged Niels `work`") so the behaviour is visible, and the
  user can drop to `suggest`/`off` any time. The FIRST auto-tag of a session also
  carries a one-line reminder that it's automatic and changeable ("…I do this
  automatically; say 'just suggest' or 'stop auto-tagging' to change that") — once
  per session only, so it surfaces the opt-out without nagging.
- **Group send ALWAYS shows the roster and confirms before sending** — this rule is
  unchanged and independent of the tagging mode. Auto-*tagging* ≠ auto-*sending*:
  applying a local label is cheap and reversible; firing N messages is not. "write
  everyone from work" must never spray N messages without the user seeing the N
  names first. This is the single most important safety rule of the feature.

### Tools (new MCP surface — deliberately minimal)
- `tag_contact(name, tag)` — add a tag (partial-name match like `send_message`;
  handle `no_contact` / `ambiguous` the same way). Normalises + dedups.
- `untag_contact(name, tag)` — remove one.
- Surface tags in the `contacts` listing (e.g. `Niels Bohr · aka Niels · work,gaming · F7wzEg`).
- **No `resolve_tag` tool.** The agent already receives the whole book from
  `contacts`, so resolving a tag → roster is a local filter on data it already has.
  A dedicated lookup tool would be redundant.
- **No `send_group` tool / no group on the wire.** A "group send" is just **N
  individual sealed 1:1 `send_message` calls**, one per recipient — same transport,
  looped. Recipients don't see each other; there's no CC and no group chat. The
  agent confirms the roster (behavioural rule below) then loops `send_message`, so
  no new send primitive is needed. (Revisit a dedicated tool only if we later want
  a single server-side chokepoint or atomic multi-send reporting.)

So the entire new surface is: `Contact.tags` + `tag_contact`/`untag_contact` +
tags in `contacts`. Everything else (suggesting, group-send confirm) is instructions.

### Opt-out: the auto-tagging setting
Auto-tagging must be switchable off — same "never auto-fire without consent" ethos
as the user-triggered live inbox. A local setting (stored in config, next to the
contact book; never sent to the server) with levels:
- **`auto`** (DEFAULT) — agent applies obvious tags silently (mentioning notable
  ones in passing). Cheap because a tag is local + reversible.
- **`suggest`** — agent proposes tags from conversation, applied only on confirm.
- **`off`** — agent never tags automatically and never asks. Manual `tag_contact`
  still works.

Toggled conversationally ("just suggest tags, don't apply them", "stop auto-tagging",
"turn tagging back on"). Layer 2a-ii (and 2a-iii) must check this setting before
applying or suggesting anything.

### Group-send flow
1. User: "write everyone from work: standup moved to 10."
2. Agent filters the `contacts` book locally for tag `work` → [Niels, Tobias, Mette].
3. Agent: "I've tagged Niels, Tobias and Mette as `work` — send to all three?"
   (Always confirm; name the roster.)
4. On yes → loop `send_message` per recipient (N individual sealed sends). Report
   once: "Sent to Niels, Tobias and Mette."

### Discoverability: report tagging state when asked
When the user asks about tagging ("are you tagging people?", "what's Niels tagged
as?", "is auto-tagging on?"), the agent answers from local state — the current
setting (`suggest`/`off`/`auto`) and/or the contact's tags — rather than staying
silent. So the feature is inspectable: the user can always find out whether it's
running and what it's decided. Spell this out in the CLAUDE.md/instructions work.

### CLAUDE.md / instructions work
Once the tools exist, add behaviour guidance mirroring the existing send/rename
sections: when to suggest a tag, the confirm-the-roster rule for group send, and
"your nick + your tags are both local and private."

### Open questions
1. **Group-send cap?** A soft ceiling / extra confirm above, say, 10 recipients so a
   broad tag can't blast a huge list on one casual sentence.
2. **Auto-apply once confident?** A future per-user setting ("auto-tag my obvious
   coworkers, ask for the rest"), but v1 always asks. Tie to Phase 2.5 tiers later.
3. **Tag-aware resolution.** Tags should eventually feed "which Sam?" disambiguation
   (prefer the `work` Sam when the context is work) — overlaps Phase 2 proper.
4. **Provenance storage** — defer `tagMeta` until 2a-iii actually needs it.

### Suggested build order
- **2a-i — ✅ BUILT (2026-06-28, v0.6.0).** `Contact.tags`; `tag_contact` /
  `untag_contact` (partial-name match, `no_contact`/`ambiguous`/`bad_tag` results,
  no-op `changed:false`); a local `settings.json` with the `auto`/`suggest`/`off`
  tag mode (default `auto`) + a `tagging` tool to read/set it; tags shown in
  `contacts`; tags preserved across rename (rememberContact upsert). Group send is
  loop-`send_message` after a roster-confirm (no new tool / no wire-level group, per
  the decision above) — the confirm + auto-tag behaviour lives in instructions.ts.
  Covered by unit tests (`contacts.test.ts` tag helpers, `settings.test.ts`,
  `tag-contact.test.ts`). Manual tagging + group send fully usable now.
- **2a-ii** — agent-suggested tags from conversation content (instructions-only;
  no new storage). This is where it starts to feel magic. *(Instructions already
  describe the per-message inference + mode-check; this phase is about exercising
  and tuning it in practice.)*
- **2a-iii** — cross-contact inference (needs the signal/`tagMeta` store).

---

*Captured 2026-06-12. Concept + plan; Phase 0 is the next build step.*
*Updated 2026-06-28: friend-of-friend (§3.3) stays parked — preferred design if
revisited is encrypted contact-list blobs on the server with friend-held keys
(server stays blind, sync without the friend being online); auto-tagging (§9) is
the active next build.*
