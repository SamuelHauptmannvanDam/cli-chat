# Live inbox + auto-respond — feature ladder

A redesign of how incoming mail surfaces. Instead of today's privacy-first
"count only, hide bodies, deal one at a time" stance, the goal is a **live inbox
that lives in the session's context**: messages accumulate as an addressable
list, and the user reads/replies to one, some, or all whenever they want.

Four autonomy tiers. **A1 (live inbox) is the current build** — see the bottom.
**A2 and A3 are documented here for later**, in build order. A0 is today.

| Tier | One line | Who writes the reply |
|---|---|---|
| A0 · Passive count *(today)* | "📬 1 from Sam — read it?", bodies hidden | User, one at a time |
| A1 · **Live inbox** *(building)* | Feed of messages in context; batch-reply freeform | User (AI sends) |
| A2 · Suggested drafts | Each message shows a pre-written reply to approve/edit/send | AI drafts, user confirms |
| A3 · Rules-gated auto-reply | AI auto-answers what a policy file allows, surfaces the rest | AI (scoped) + user |

---

## A2 · Suggested drafts (deferred)

**Experience.** The live-inbox feed (A1) renders each pending message *with a
pre-drafted reply attached*. Nothing sends until the user says so.

```
📨 3 waiting
  [1] Niels — "you around for the 3pm?"
      ↳ draft: "Yep, I'll be there."
  [2] Sam   — "did the deploy land?"
      ↳ draft: "Just went live a few minutes ago."
  [3] Ana   — "lunch tomorrow?"
      ↳ draft: "Can't tomorrow — Thursday?"
```

User drives disposal in one turn: *"send 1 and 2, change 3 to 'Friday works'."*

**Why it exists.** It's the trust-building step between "I write every word"
(A1) and "it answers for me" (A3). The user watches the AI's wording on real
messages, with a veto, before ever letting it send unattended.

**Mechanics.**
- After A1 assembles the pending list, add a draft-generation pass: for each
  message, the AI drafts a reply using available context (contact, recent
  thread, calendar/availability if connected).
- Render drafts inline in the feed; carry each message id.
- Disposal maps a freeform user instruction → per-id actions
  (`draft_reply` to send, edit-then-send, or skip).
- Default is **send nothing**: an un-actioned draft stays pending, never fires.

**Build notes.** Reuse `draft_reply` for sending. New work is the draft pass +
feed rendering + the approve/edit/skip parse. No server changes.

---

## A3 · Rules-gated auto-reply (deferred)

**Experience.** The AI auto-answers messages that match the user's own
guidelines and surfaces everything else into the A1 feed. "Check my md
guidelines, see what it's allowed to respond to, take it from there."

**The policy file — `AUTORESPOND.md`.** Default-**deny**: nothing auto-sends
unless a rule matches.

```md
# Auto-respond rules
- From Niels: if he asks whether I'm free, check my calendar and answer.
- Anyone asking "did it deploy / is it live": reply with current status.
- Delivery / "on my way" pings: auto-acknowledge ("got it, thanks").
- Never auto-reply about money, commitments, or dates I haven't scoped
  → always surface to me instead.
```

**Evaluation (per incoming message).**
1. Match the message against the rules (by sender, and by intent/topic).
2. If a rule matches **and** the AI is confident it can satisfy it → draft +
   send via `draft_reply`, then log it.
3. Otherwise → fall through to the live inbox (A1) for the user.

So autonomy only ever *expands* the allow-list; the floor is always "surface
it." Unmatched, low-confidence, or sensitive-topic messages are never
auto-answered.

**Safety rails.**
- **Audit log** of every auto-sent reply (`auto-sent.log`), shown to the user on
  their next turn: *"While you were away I told Niels you're free at 3 — ✅ /
  undo."*
- **Confidence threshold**: a near-miss surfaces instead of guessing.
- **Hard never-list** (money, dates, commitments) overrides any allow-rule.
- Rules can be per-contact or per-topic; easy to disable globally.

**At-keyboard vs away.**
- *While a session is open*, A3 runs on the **per-session listener** — fine.
- *While the user is away with no session open*, auto-respond needs the
  **standalone daemon** (see PUSH.md boundary #2). That promotion is the only
  feature that justifies installing a background service.

**Build notes.** Needs the rules-file parser, an intent matcher, the
confidence gate, and the audit log. Server unchanged for the at-keyboard case;
the away case requires the daemon.

---

## A1 · Live inbox (current build)

The foundation everything above renders through.

- A background listener keeps a **pending list** current — `{id, from, body,
  arrived_at}` — and never auto-marks-read. Messages just accumulate.
- On any turn (user types, or the listener exits-on-arrival and re-invokes),
  the **whole pending batch** renders as a feed with ids.
- The user replies across the list freeform ("tell Niels yes, Sam it's live,
  skip Ana"); the AI fans out `draft_reply` per id and reports what went where.
- A message stays pending until the user disposes of it — nothing scrolls away
  unanswered.
- Substrate: **per-session background listener**, no install. (Daemon only
  needed later, for A3-while-away.)

### Build steps (in order)

1. **`src/await-mail.ts` — the listener.** Loads identity/contacts like
   `check-inbox.ts`. Reads the warmer's pending snapshot (never opens `inbox.db`
   directly — avoids the two-writer wasm-SQLite hazard). Computes the diff vs a
   last-surfaced marker; **blocks** (watch the snapshot file + slow poll
   fallback) until new pending appears; prints the batch as JSON lines
   (`{id, from, body}`) to stdout; exits 0. Does **not** mark read — accumulate
   semantics; disposal happens when the user replies. Fails clean on `no_account`.
2. **Spawn-command tool in `src/server-net.ts`.** A small MCP tool (e.g.
   `start_listening`) that returns the exact local command to run
   (`node <dist>/await-mail.js` + env) so the agent never guesses a path.
3. **Instructions (`src/instructions.ts` + CLAUDE.md).** Teach the trigger:
   on "listen"/"go live" → call the tool → spawn backgrounded → on each
   completion render the pending **feed** and **relaunch**; on "stop" don't
   relaunch. Define the batch-reply behavior (freeform → `draft_reply` per id).
4. **Reconcile with `check-inbox.ts`.** While the listener is active the feed
   owns surfacing, so the count-only hook must not also mark mail read / hide it.
   Decide: listener-active suppresses the hook's claim, or both share one pending
   list + marker. (Integration point — get this right so mail isn't double-claimed.)
5. **Build wiring (`build.mjs`).** Bundle `await-mail.ts` into `dist/`.
6. **Tests.** Unit: the pending-diff/marker logic. Integration: spawn → message →
   batch on stdout → exit.
7. **Docs.** README "Receiving messages": add the listener mode. Bump version.

**Acceptance:** fresh install → say "listen" → one permission click → send a test
message from another account → feed appears hands-free → "reply to all: …" sends.

### What A1 requires server-side: nothing

A1 is **client-only**. The push path it needs is already deployed — the Inbox
Durable Object + `/connect` WebSocket (`server-mailbox/inbox-do.ts`,
`worker.ts`, `wrangler.toml.example`), which the warmer already consumes. No new
Cloudflare component, **no new MCP server**: A1 adds a CLI subcommand + one small
tool to the existing `cli-chat-mcp` package. The listener learns of new mail by
**reusing the warmer's socket** — it watches the local pending snapshot the
warmer already fills from `/connect`, so it opens no new connections and adds no
relay load.

### Activation: on chat, by a word (no install)

A user already on `cli-chat-mcp@latest` activates A1 by **saying it in chat** —
e.g. "listen" / "go live". Nothing to install: the listener binary ships in
`dist/` and the trigger behavior ships in the MCP `instructions`. Flow:

1. User says **"listen"** in chat.
2. Agent (per instructions) calls the MCP tool to get the exact spawn command,
   then runs it as a **backgrounded Bash task**.
3. **One-time** shell-permission click (allow-always) on CLIs that gate shell.
4. Listener is live in the background; each new-mail batch exits → re-invokes the
   agent → feed renders → relaunch. "stop" ends the loop.

Beyond today's onboarding, the only added friction is **one word per session +
one permission click ever**.

### Design principle: explicit, user-triggered start (don't auto-spawn)

The listener is **started by the user each session**, on purpose — e.g. "watch"
/ "go live" / a `/inbox` command → the agent launches it as a backgrounded Bash
task. It is deliberately **not** auto-spawned from a SessionStart hook or at
MCP boot. The manual start is the feature: the user stays in control and *knows*
the channel is live — "this is my chat terminal." Keep it that way; don't move
the start into automatic plumbing.
