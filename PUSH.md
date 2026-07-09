# Push delivery spec — background WebSocket warmer

Status: implemented and deployed. The background warmer runs in the MCP server;
the live mode is the "chat" inbox (await-mail waker + `chat_batch`, see
`LIVE-INBOX.md`), which replaced the old in-call `watch` tool. The desktop
notification is opt-in via `MESSENGER_NOTIFY=1`, off by default.
Superseded the 3-second poll loop in `listen_for_messages`.

## Goal
Deliver new mail to a user's machine **the instant it lands**, while the user keeps
chatting freely in the same terminal — and without the wasteful 3s polling that
makes server cost scale with *idle listeners* instead of *actual messages*.

The design lives entirely within **MCP + a standard CLI** (Claude Code, etc.). No
custom client. The one thing it deliberately does NOT attempt: making a message
render in the terminal mid-idle with zero keystroke (impossible in a turn-based
agent — see [Boundaries](#boundaries)).

## The core idea: receive in the background, surface on a turn
Today receiving is tied to a **blocking tool call** (`listen_for_messages`), which
occupies the agent's turn — so you can't chat while it runs. That coupling is the
problem, not the transport.

Instead, do the receiving in the **MCP server process itself**, which is alive for
the whole session and runs its own event loop independent of tool calls. It holds
a WebSocket in the background, drains new mail into the local cache, and (opt-in
via `MESSENGER_NOTIFY=1`) fires a desktop notification — all **without occupying
the agent**. The agent stays free
to chat. Messages then surface through the normal turn mechanisms:

| Path | When it shows | Occupies agent? |
|---|---|---|
| Background warmer (WS in MCP server) | writes cache + desktop notify (opt-in `MESSENGER_NOTIFY=1`), **instant** | ❌ no |
| `check-inbox` hook (on each prompt) | "📬 new from Sam — read it?" on your **next turn** | ❌ no |
| `listen_for_messages` (now optional) | full body into context, instant | ✅ yes (opt-in only) |

So the everyday experience: **chat normally; incoming mail warms the cache + pings
you instantly; you see "want me to read it?" on your next keystroke.** The blocking
watch tool becomes an opt-in "read it into context the moment it arrives without me
typing" mode — no longer the default, and no longer needed to stay current.

## Architecture
```
sender ──POST /messages──▶ Worker ──┬─▶ D1 (source of truth, persisted)
                                    └─▶ Inbox Durable Object(recipient)
                                              │ wake frame
                                              ▼
                              recipient's MCP server (background WS)
                                              │ on wake → sync(ctx)  [existing pull]
                                              ▼
                          local cache (~/.cli-chat) + desktop notify (opt-in: MESSENGER_NOTIFY=1)
                                              │
                                   surfaced on next turn (hook) / or watch tool
```

### Server side (Cloudflare Workers + D1 + Durable Objects)
Additive to the existing `server-mailbox/` Hono app — all current HTTP routes
(`POST /messages`, `GET /mailbox`, `/register`, `/resolve/:handle`, `/health`)
stay exactly as-is. Pull remains fully functional; push is an accelerator on top.

- **Inbox Durable Object**, one instance per recipient: `idFromName(recipientSignPub)`.
  Holds the recipient's live WebSocket connections.
- **Hibernation API**: use `state.acceptWebSocket(ws)` + the `webSocketMessage` /
  `webSocketClose` handlers. Idle connections **hibernate** — they cost ~nothing
  and don't keep the DO billed while waiting. This is what makes idle listeners
  free.
- **New route `GET /connect` (WebSocket upgrade)**: authenticates the subscriber
  (below), resolves the DO for that recipient, and hands the socket to it.
- **Fan-out on send**: in the existing `POST /messages` handler, after the D1
  insert, get the recipient's DO stub and call it to push a **wake frame** to all
  that recipient's connected sockets.

#### What gets pushed: a "wake", not the message
The DO pushes a tiny **wake signal** (e.g. `{"t":"mail"}`), *not* the message
body. On wake, the client runs its existing authenticated `GET /mailbox` pull
(`sync(ctx)` in `core-net.ts`) to drain + decrypt + mark-fetched.

Why wake-then-pull instead of pushing ciphertext directly:
- **D1 stays the single source of truth**; no second delivery path to dedupe.
- **Reuses all existing client code** — the warmer's only job on wake is to call
  `sync(ctx)`, which already drains, decrypts, caches, and marks fetched.
- Cost is one extra sub-second round-trip per message — negligible at chat rates.

#### WebSocket auth
The MCP server runs on Node, so it can set arbitrary headers on the upgrade
request — reuse the existing Ed25519 signed-request scheme (`auth.ts` /
`canonical.ts` / `verify.ts`):
- Client signs a canonical string over `(method=GET, path=/connect,
  recipient=signPub, ts=<now>)` with its `signSec` and sends signature + `ts` +
  `signPub` as upgrade headers.
- Worker verifies the signature against `signPub` and rejects stale `ts`
  (replay window, same as HTTP). Only then does it accept the upgrade and route to
  `idFromName(signPub)`. This proves the subscriber owns the inbox it's
  subscribing to.

#### `wrangler.toml`
Add a Durable Object binding + migration:
```toml
[[durable_objects.bindings]]
name = "INBOX"
class_name = "Inbox"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Inbox"]   # DO with SQLite storage backend
```
(D1 binding, cron retention sweep, worker name all unchanged.)

### Client side (the MCP server, `src/server-net.ts`)
A **background warmer**, started at server boot, fully decoupled from tool calls:

1. **Connect**: open the authenticated WS to `wss://<mailbox>/connect`.
2. **On open**: run one `sync(ctx)` immediately — drains anything that arrived
   while this device was offline. (Catch-up; never rely on the socket for missed
   mail.)
3. **On wake frame**: run `sync(ctx)`; if it added anything, fire an optional
   desktop notification (`osascript` / `notify-send`, opt-in via `MESSENGER_NOTIFY`).
   Do **not** mark read — the agent still surfaces it on a turn.
4. **Reconnect**: exponential backoff on drop (e.g. 1s→2s→…→30s, jittered). On
   every successful reconnect, step 2 again.
5. **Fallback poll**: a slow safety-net `sync(ctx)` on a long interval (e.g. 60s)
   in case a wake is ever missed. This replaces the 3s loop — 60s idle polling is
   ~20× cheaper and is just a backstop, since push handles the real-time path.

Everything here runs on the MCP server's event loop between tool-call handlers —
it never blocks a turn.

#### `check-inbox` hook (unchanged behavior, now reads a warm cache)
On `SessionStart` / `UserPromptSubmit` it reads the **local cache** (already warmed
by the background WS — no network needed) and emits the lightweight
`systemMessage`: count + sender + "want me to read it?". Bodies go to the agent via
`additionalContext`, surfaced only if the user says yes. Same as today, just faster
and offline-resilient.

#### Live chat (the explicit hands-free mode — AS IMPLEMENTED)
The explicit "lean back, read mail straight into context the instant it arrives"
mode is the live inbox the user opens by saying **"chat"** — see `LIVE-INBOX.md`
for the full design. In short: `start_chat` hands the agent a shell command for the
`await-mail` **waker**, which the agent runs as a BACKGROUND task. The waker blocks
on the warmer's pending snapshot and exits the moment unsurfaced mail lands; on each
exit the agent calls `chat_batch` to drain the batch and relaunches the waker. This
keeps the turn free while idle (the waker runs out of band, not inside a tool call)
and works in any client that can background a process. The old in-call `watch`
long-poll tool has been removed.

### Concurrency note (ties to the `db.ts` decision)
Two processes touch `~/.cli-chat`: the long-lived MCP server (warmer, writing) and
the per-event `check-inbox` hook (reading). They can overlap. Handle with either:
- the `node-sqlite3-wasm` cache (real SQLite file locking, portable, Node 20+), or
- atomic JSON writes (write-temp + rename) with last-writer-wins.

Either is fine at this write rate. See the engines/back-compat discussion — this is
the same store swap that drops the Node floor off `node:sqlite`/Node 24.

## Delivery semantics
- **At-least-once.** D1 is the source of truth; the wake frame is only a trigger.
- **Missed wake → caught by**: (a) the slow fallback poll, (b) the on-connect
  catch-up sync, (c) the SessionStart hook next time the CLI opens. A dropped
  socket never loses mail.
- **Dedup** is already handled by `markFetched` / the cache primary key — a wake
  that races a poll just no-ops.

## Boundaries (what this still cannot do)
1. **No unprompted in-terminal display while idle.** The agent only emits on a
   turn; MCP has no "inject a line into the live chat" path. Idle users get an
   instant **desktop notification**; the in-chat "read it?" appears on their next
   keystroke. (Push doesn't change this — it's the turn model.)
2. **No delivery when no CLI session is open.** The socket lives in the MCP server,
   which only exists during a session. Reaching a fully-offline user again needs a
   standalone background daemon — explicitly out of scope for "MCP + standard CLI"
   (it's the watcher/service that was removed).

## Why this scales
- **Idle cost ≈ 0**: one hibernated socket per online user, no 3s hammering.
  Request volume scales with **messages sent**, not with **listeners × time**.
- Recall the poll math: 3s polling = ~1,200 req/hr per active listener; ~100
  continuous listeners ≈ 86M req/month. Push collapses that to roughly one wake +
  one pull per actual message.
- D1 reads were never the binding constraint (billions/month); Worker **request
  count** was — and that's exactly what push removes.
