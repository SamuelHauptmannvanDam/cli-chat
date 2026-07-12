# Live inbox — the "chat" mode

How incoming mail surfaces when the user goes hands-free. Alongside the default
privacy-first "count only, hide bodies, deal one at a time" stance, saying
**"chat"** opens a **live inbox that lives in the session's context**: messages
accumulate as an addressable list, and the user reads/replies to one, some, or
all whenever they want.

- A background listener keeps a **pending list** current — `{id, from, body,
  arrived_at}` — and never auto-marks-read. Messages just accumulate.
- On any turn (user types, or the listener exits-on-arrival and re-invokes),
  the **whole pending batch** renders as a feed with ids.
- The user replies across the list freeform ("tell Niels yes, Sam it's live,
  skip Ana"); the AI fans out `send_message` (in_reply_to) per id and reports what went where.
- A message stays pending until the user disposes of it — nothing scrolls away
  unanswered.
- Substrate: **per-session background listener**, no install, no daemon.

## The pieces

1. **`src/await-mail.ts` — the chat WAKER.** A detector, not a deliverer. In push
   mode it only WATCHES the warmer's pending snapshot (never opens `inbox.db`) and
   **blocks** until the snapshot shows mail not yet acked, then **exits 0** —
   carrying no output the agent reads. In poll mode (no warmer) it drains until
   unread appears and exits, without marking read. Heartbeats `chat.lock` each
   tick. Fails clean on `no_account` (just exits). *Why waker-not-printer: the
   agent never reads its stdout, so the temp output-file path stays off screen.*
2. **`src/server-net.ts` — the chat tools + `chat_batch`.** `chat` / `auto_draft_chat` / `auto_chat` each return the
   waker command (env embedded only when non-default, so the shown command stays
   clean). `chat_batch` DELIVERS the batch — reads the pending snapshot and acks
   it (or drains directly when no warmer) — so the feed's content arrives via a
   clean named tool call instead of the agent reading the waker's temp file.
3. **Instructions (`src/instructions.ts` + CLAUDE.md).** The trigger: on
   "chat"/"go live" → call the tool → spawn backgrounded → on each completion
   render the pending **feed** and **relaunch**; on "stop" don't relaunch.
   Batch-reply behavior: freeform → `send_message` with in_reply_to, per id.
4. **Reconciled with `check-inbox.ts`.** The listener heartbeats a `chat.lock`
   (mtime) every tick; the hook treats a lock fresh within 15s as "chat is live"
   and suppresses its count-only notice on keystroke/turn-end (SessionStart still
   runs). So the feed is the sole surfacing path while chat is on — no
   double-announce — and the lock simply goes stale on stop/kill. Since 0.12.0
   the lock body is JSON `{at, mode}`: mode "quiet" (quiet auto chat,
   AUTO-CHAT.md) sharpens the suppression to "everything except the assistant's
   escalation self-mail".

## What it requires server-side: nothing

The live inbox is **client-only**. The push path it needs is already deployed —
the Inbox Durable Object + `/connect` WebSocket (`server-mailbox/inbox-do.ts`,
`worker.ts`, `wrangler.toml.example`), which the warmer already consumes. No
extra Cloudflare component, **no new MCP server**: it's a CLI subcommand + one
small tool in the existing `cli-chat-mcp` package. The listener learns of new
mail by **reusing the warmer's socket** — it watches the local pending snapshot
the warmer already fills from `/connect`, so it opens no new connections and
adds no relay load.

## Activation: on chat, by a word (no install)

A user on `cli-chat-mcp@latest` activates it by **saying it in chat** — the
trigger word is **"chat"** (also "go live" / "start chat"). Nothing to install:
the listener binary ships in `dist/` and the trigger behavior ships in the MCP
`instructions`. Flow:

1. User says **"chat"** in the session.
2. Agent (per instructions) calls the MCP tool to get the exact spawn command,
   then runs it as a **backgrounded Bash task**.
3. **One-time** shell-permission click (allow-always) on CLIs that gate shell.
4. Listener is live in the background; each new-mail batch exits → re-invokes the
   agent → feed renders → relaunch. "stop" ends the loop.

Beyond onboarding, the only friction is **one word per session + one permission
click ever**.

## Design principle: explicit, user-triggered start (don't auto-spawn)

The listener is **started by the user each session**, on purpose — they say
**"chat"** (or "go live") → the agent launches it as a backgrounded Bash
task. It is deliberately **not** auto-spawned from a SessionStart hook or at
MCP boot. The manual start is the feature: the user stays in control and *knows*
the channel is live — "this is my chat terminal." Keep it that way; don't move
the start into automatic plumbing.
