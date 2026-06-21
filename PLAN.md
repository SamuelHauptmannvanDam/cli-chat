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
   What's exposed, and with what consent/privacy boundary?
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
  `src/watch.ts`.
- **Cleanup (2026-06-16):** removed the superseded Phase 0 local stack
  (`server.ts`, `core.ts`, `config.ts`, `setup-identities.ts`, `AGENT.md`,
  `test/roundtrip.ts`, `test/live.ts`). Stack is Node/TS throughout.

### Phase 2 — Smarter resolution & learned tags
- Encrypted meta tags on send (company, mutual contacts, topic) — §3.4.
- Disambiguation when >1 candidate for a name.
- Tagging improves future "which Tobias?" confidence.

### Phase 3 — Social-graph fuzzy resolution
- "Write Tobias" with no local Tobias → search friends-of-contacts → "Tobias connected to
  Niels?" (§3.3). Needs the consent/privacy model for shared graph queries (open Q #3).
- This is the privacy-heaviest feature — design the boundary before building.

### Phase 4 — Real-time push
- Durable Objects + WebSocket so messages surface while the CLI is already idle-open.
- Replaces poll-on-open as the primary signal; polling stays as fallback.

### Cross-cutting, tracked but unscheduled
- Spam/abuse gating on "message anyone by name" (open Q #7). **Partly landed:**
  server-side new-sender admission control. A sender the recipient has never
  written to is "unknown" and rate-limited by two rolling-hour caps — per
  `(sender→recipient)` pair (stops one stranger flooding) and per recipient
  across all unknown senders (the Sybil backstop, since fresh keys are free).
  Replying to someone (or messaging them first) makes them "known" and exempt,
  tracked in a durable `known(owner, peer)` ledger and counted on the server's
  receive clock so a sender can't back-date their way out of the window. Tunable
  via `MAILBOX_UNKNOWN_PAIR_HOURLY` / `MAILBOX_UNKNOWN_RECIPIENT_HOURLY`. Still
  open: explicit block/mute, handle rotation, and surfacing unknown mail as an
  accept/ignore "request" rather than silently throttling at the edge.
- Key discovery & trust between users (open Q #2).
- Consent boundaries on what the agent may auto-send (open Q #5).

---

*Captured 2026-06-12. Concept + plan; Phase 0 is the next build step.*
