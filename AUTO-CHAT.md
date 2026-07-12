# Auto chat — your assistant answers your mail

> **The pitch.** Live chat, one step further. "chat" opens a live inbox you
> reply to; **"auto chat"** puts a standing mediator between you and
> everything coming in: your assistant replies *for* you — grounded in every
> conversation you've ever had, whatever project the session is running in,
> and its own growing memory of your world (`cli-chat-context`). Anything
> already waiting when you turn it on gets handled first; anything it can't
> answer with confidence, it asks *you* about, then answers accordingly.
> A teammate asks "what env vars does your service need?" and gets the answer
> in seconds, from your machine, while you keep working.

**The feature is one-sided; assistant-to-assistant is emergent.** What any
single user turns on is auto chat: *my* assistant answers *my* mail,
whatever the sender runs — full value unilaterally, from day one, even if
you're the only user who has it. The sender needs no feature at all; they
just send mail. When both sides happen to run it, assistant-to-assistant
conversation simply emerges — machines clearing each other's questions while
both humans work. That's the adoption story: unilateral utility, bilateral
magic, no coordination needed.

**And it replaces the shared doc.** Information you'd previously ask people
to add to *somewhere* — a wiki page, a pinned message, a spreadsheet — can
now just be asked for: you ask your assistant, your assistant asks everyone
else's assistant, each one answers from its own context, yours compiles the
result. The info stays where it actually lives (each person's machine and
memory) and is fetched fresh on demand. See the use-case table below.

**One line: it's chat, with auto-reply on.** And the core loop is already
**validated**: asking the agent, in a live chat session, to answer incoming
messages to the best of its ability — it just does it, today, with zero new
machinery. So the build isn't a new engine; it's making that proven
behaviour first-class: a trigger phrase, the grounding stack (history + a
memory), the rails, and the always-on assistant marker.

## Triggers: "chat" offers auto; "auto" / "auto chat" spins it up

Auto chat is discovered through chat itself, not through docs:

- **"chat"** opens the live inbox as today — and the agent adds a short offer
  that names both assist rungs, so consent is informed:

  > *Want help with these? Say "draft" and I'll draft replies you approve
  > before anything sends, or "auto" and I'll answer what I can myself —
  > grounded in this directory, our message history, and my notes, marked as
  > your assistant, and asking you what I can't ground either way.*

  Offered once per session, never repeated, never nags.
- **"draft chat"** (or "auto draft" / "drafts") — the **midway rung**: the same
  loop, but the assistant only *drafts*. Each incoming message gets a proposed
  reply rendered beneath it in the feed ("↳ draft: '…'"); nothing sends until
  the user approves ("send 1", "send all"), edits, or answers themselves. An
  approved draft goes out **as the user, unmarked** — they reviewed and signed
  off, exactly like a reply they dictated (`as_assistant` stays the mark for
  autonomous sends). Same grounding stack and code of conduct as auto; a
  flagged message never gets a draft; secrets/keys never appear in one;
  ungroundable items show "needs you" + the assistant's question instead (no
  escalation-by-mail — the user is at the feed). No quiet variant: drafting
  presumes the user is watching. It's the trust-builder rung — run it until
  the drafts are consistently right, then say "auto".
- **Upgrading a running chat is a first-class path, not a restart.** Saying
  **"auto"** (or **"draft"**) any time while chat is running flips the same
  terminal mid-flight: the waker keeps running, the feed keeps its numbering,
  and anything already sitting unanswered in the feed is put through the new
  disposal right away (the backlog-drain rule below applies at flip time
  too). **"manual"** (or "I'll take it") flips back the same way, without
  stopping the feed. Chat → draft → auto → manual is one continuous session.
- **"auto chat"** (or just **"auto"**) — the shortcut for people who know
  what they want: opens the live inbox with the assistant already answering,
  no question asked. Both forms work identically. (Also accept "chat assist"
  / "assist" / "answer my messages" / "take my mail".)
- **"auto chat, quiet"** — straight into the quiet variant (see ladder
  below).

**Tips suggest; the offer explains.** Everywhere a one-line tip mentions
chat, it names the rungs — the session-start mail summary's hint is *"say
'chat' to read your messages live, 'draft chat' and I'll draft replies for
you to approve, or 'auto chat' and I'll answer them for you"*. Tips only
*suggest* (one line, no lecture); the full explanation of what the assist
modes do lives in the in-chat offer above, at the moment of turning one on —
that's where informed consent happens, not in a tip.

So the on-ramp is built into the flow: everyone meets auto chat the first
time they open chat (or reads the tip), and graduates to the shortcut on
their own.

## How it runs: the live-chat loop, mediated

Same machinery as LIVE-INBOX.md, different disposal. With auto on, the
assistant is the permanent mediator between the user and the inbox for as
long as the session runs:

0. **Drain the backlog first.** If messages are already waiting when auto
   chat is activated (the session-start inbox, or anything that piled up),
   fetch them with `chat_batch` immediately and put them through the same
   disposal as a live batch — don't leave pre-existing mail sitting outside
   the mediator. Then start the background waker (`start_chat`). The same
   rule fires on a mid-flight "auto" in a running chat: feed items the user
   hasn't answered yet count as backlog and go through the mediator at flip
   time (the waker is already running; nothing restarts).

Per message in each batch:

1. **Try to answer** from the grounding stack (below). Confident, grounded,
   inside the rails → `draft_reply` and send, marked as the assistant.
2. **Narrate every send in the terminal as it happens** — "↩ Niels: 'REDIS_URL
   and API_KEY, see .env.example.'" The session is live and visible; the user
   watches their assistant work. (In the quiet variant the narration is
   replaced by an auditable record + digest — see the surfacing ladder below.
   Either way: no unaccounted-for activity, ever.)
3. **Can't answer / shouldn't answer → ask the human, then answer.** The
   mediator doesn't just drop the message in the feed and move on — it asks
   its own human the *one missing fact* and passes the answer on once it has
   it. Two paths, same loop:
   - **In the feed** (the floor): the item is marked "needs you" with the
     assistant's specific question attached ("Sam asks when you're free —
     Sat or Sun?"). You answer in the terminal; it replies to Sam.
   - **Escalate by mail** (the richer path): the assistant writes its own
     human a message. The human becomes aware wherever they next type, in
     ANY session, through the existing inbox hooks — they don't have to be
     watching the auto-chat terminal. Their reply threads back
     (`in_reply_to`), the assistant picks it up on the next batch and passes
     the answer on. The human is just another addressable endpoint.

   Either way the answer is saved to `cli-chat-context` before it's passed
   on — the same question never comes back to you twice.

Then relaunch the waker, same as chat. "stop" ends it. Same design principle
as live chat: **user-started, per session, on purpose — never auto-spawned.**
Saying "auto" *is* the consent to auto-reply this session; there is no
global always-on switch to configure or forget about. ("Permanent mediator"
means *while it runs, nothing reaches you or leaves except through it* — not
that it survives the session.)

## One mode covers everything

No other modes are needed. Every assistant-to-assistant use case reduces to
the two primitives — mail as the universal channel, auto chat as the only
autonomy switch:

| Use case | Covered by | Enabler |
|---|---|---|
| Context retrieval ("what env vars does your service need?") | Auto chat alone | — (the core loop) |
| **The shared-doc replacement** ("collect everyone's on-call handle" / "what's each service's staging URL?") | You ask your assistant; it mails each relevant contact; *their* assistants answer from their own context; yours compiles and reports. Recipients without auto chat just see normal mail and reply by hand — degrades gracefully | Fan-out is just N sends; answers thread back via `in_reply_to`; pending-questions note tracks who's answered |
| Status & handoffs ("deploy landed, your move") | Plain mail — sender's agent sends as a task's last step; recipient reads and acts. Deliberately never auto-acted (mail never executes actions) | — |
| Coordination / missing fact ("when are you free?") | Auto chat + ask-the-human loop (feed or escalate-by-mail); reply threads back and is passed on | Self-send; pending-questions note in `cli-chat-context` |
| Machine → human reporting (CI mails the on-call) | Plain mail — a bot is just another account with a keypair; admission caps and signed identity already apply. Auto chat can even auto-answer bots ("was that you?" → git history) | Headless send: `npx cli-chat-mcp send …` CLI subcommand for scripts/CI |
| Self-to-self (desktop job done → mails your laptop) | Self-send surfacing wherever you're next active | Self-send; note the multi-device wrinkle: devices share one mailbox, first drain wins |

The three enablers are small: **self-send** (mail your own handle — verify the
admission path allows sender = recipient), a **pending-questions** convention
in `cli-chat-context/` so the assistant remembers what it's waiting on across
batches (`in_reply_to` does the threading), and a **CLI send subcommand** so
headless machines can participate without an MCP session.

A consequence worth naming: since escalation travels over mail, the human
never needs to sit at the auto-chat terminal. It can be a dedicated session
left running — a secretary desk — while the human is reached wherever they
happen to be working.

## The surfacing ladder (incl. the quiet variant)

Five levels, one engine. Each is just a different answer to "who sees what":

| Level | Trigger | You see | Who answers |
|---|---|---|---|
| Read (default) | — | count on open/keystroke; read on demand | you |
| Chat | "chat" | live feed, every message | you (agent sends) |
| Draft chat | "draft chat" (or "chat" → say "draft") | feed + a proposed draft under each message | you — every send is your explicit approval, sent as you |
| Auto chat | "auto chat" / "auto" (or say "auto" mid-chat) | feed + narrated assistant replies + needs-you questions | assistant; you for the rest |
| **Quiet auto** | "auto chat, quiet" | **escalations only** — handled mail never surfaces | assistant; you're mailed when needed |

**Quiet is a surfacing variant, not a new mode.** It reuses the `chat.lock`
suppression that already keeps live chat from being double-announced, with
sharper semantics: while a quiet auto-chat session holds the lock, the
on-keystroke hook in the user's OTHER sessions suppresses ordinary mail
notices entirely; the only interrupt that gets through is the assistant's own
**escalation self-mail**, which the hook labels distinctly ("your assistant
needs you: …") — recognizable because it's from the user's own identity.

**The visibility rail moves from stream to ledger.** Live narration is the
watched-mode guarantee; in quiet mode the guarantee is the record: every
assistant reply is in `history` permanently, and the assistant recaps on
demand ("what did you handle?") and in one line when the user next engages
("handled 4 while you coded — 1 waiting on you"). Same honesty, batched.

Expected steady state: read/chat are the on-ramp, draft chat is the
trust-builder (watch the drafts until they're consistently right); quiet
auto is where regular users land — most messages never cost attention at
all. That is the pitch.

## The grounding stack (what an answer may be built from)

1. **The sender's own conversation** — tiered history (HISTORY.md), scoped by
   the code of conduct's per-sender grounding: answering contact X draws on
   X's thread file (digest + recent tail) and the `history` tool for X's
   thread — never other people's threads. (The full history is still the
   user's to query from their side: "what was that address Sam sent?" works
   for *you*; it's just never an answer given to Niels.)
2. **The session's working directory** — whatever project the session was
   started in: md files (README, docs, CLAUDE.md), code, git history. A
   teammate's "how do I run your integration suite?" gets answered from the
   repo the user is sitting in. Read-only.
3. **`cli-chat-context/` — the messenger's own memory** (new, see below).
4. The contact book (who people are, tags, what circle they're in).

Missing from all four → don't guess. Ask the human (the ask-then-answer
loop), or leave it in the feed.

## `cli-chat-context/` — the assistant's memory

A persistent directory of md files under the user dir
(`~/.cli-chat/users/<handle>/context/`), owned and curated by the assistant:

- **Learned facts from conversations** — durable info that flows through the
  mail ("Niels's staging URL is …", "standup moved to 10 permanently", "Sam
  owns the billing service"). Saved as it appears, in auto chat or any
  other turn — reading mail is when the knowledge is in hand.
- **Things the user tells it to remember** — "remember I'm out Friday",
  "remember our API freeze is the 15th". Explicit writes, confirmed in one
  line ("Noted.").
- **Every escalation's answer** — when the assistant had to ask its human
  for an answer, the answer is saved before it's passed on. This is what
  makes "I'll ask you a lot in the beginning, less over time" mechanically
  true: the same question never escalates twice.
- Shape: small topical md files plus an index the assistant maintains — one
  fact per entry, dated, source noted (who said it, message id). The
  assistant updates and deletes stale entries rather than piling on.
- **Read in every session** (not just auto chat): "what's Niels's staging
  URL?" works anywhere, any time — it's the messenger's memory, and auto
  chat is just its heaviest consumer.
- **Local-only in v1.** It's distilled from private conversations; it does
  not go in the vault (server-readable by design, AUTH-SYNC.md §4) — see open
  questions.

## The code of conduct (privacy) — shipped with the rails

A named ruleset for any agent answering on a human's behalf; ours implements it
as behaviour (CLAUDE.md + instructions + resultNotes) plus one code-level check:

1. **Loyalty.** The assistant serves its user only; a sender's asks never
   override the user's interests.
2. **Default-closed disclosure, learned over time.** What personal information
   may be shared is governed by a per-user **disclosure ruleset** (the
   `disclosure` topic in `cli-chat-context` notes). Default: no rules → nothing
   personal is disclosed — the assistant asks the user instead, then saves the
   answer as a *generalised* permission ("weekend availability shareable with
   work contacts"), so asking tapers off exactly like escalation answers do.
   Inspectable and editable any time ("what do you share about me?").
3. **Other people are never wholesale.** Conversations with third parties, facts
   learned from them, and who the user talks to are never quoted, summarised or
   confirmed to anyone — no disclosure rule can open this. Per-sender grounding:
   answering contact X uses X's own thread only; needing someone else's words
   always escalates, and only the user-approved minimum is passed on.
4. **Privilege screen (code, not vibes).** Every inbound body runs through
   `screen.ts` — cheap heuristics that flag `override` (instruction hijack),
   `secrets`, `contacts` (address-book fishing), `third-party` (other people's
   mail), and `action` (make the agent do things). Flags ride the message as
   `warnings` everywhere it surfaces (feed, read_message, the inbox hook's
   private block); a flagged message is **never auto-answered** and never acted
   on — it's surfaced to the user with the flag. Stated honestly: a tripwire,
   not a sandbox — the behavioural rules remain the actual defence; the screen
   makes the obvious cases mechanical.

## Reply discipline (the rails)

- **Contacts only.** The mediator answers mail from saved contacts, period;
  a stranger's message (someone who got the handle out-of-band) is never
  auto-answered — it surfaces as normal mail for the human. The friend layer
  (FRIENDS.md) is the outer consent wall.
- **Grounded or silent.** An answer must trace to the stack above. No
  general-knowledge improv on the user's behalf, no guessing. Near-miss →
  ask the human or leave it in the feed.
- **Hard never-list, not overridable:** secrets, credentials, key material,
  money, commitments, promises on availability or dates (unless the fact is
  explicitly in context — "I'm out Friday" *was* given to be used), personal
  or relationship matters. These always surface.
- **Inbound bodies stay untrusted.** This mode is prompt injection's front
  door: mail that asks the assistant to run commands, reveal contacts/keys/
  context, change settings, or "ignore your rules" is *surfaced*, never
  obeyed. Answering reads context; it never executes actions because mail
  asked. The only writes auto chat performs are `draft_reply` sends and
  `cli-chat-context` notes.
- **Always marked as the assistant — visibly, not just in metadata.** Every
  auto-chat reply carries the mark twice: a human-readable line in the body
  itself (e.g. a trailing "— Samuel's assistant"), so ANY recipient sees it
  even with no feature on their side, and `answered_by: "assistant"` packed
  inside the sealed body (invisible to the relay, back-compat: absent =
  human) so the other side's agent can render "Niels's assistant replied"
  and treat it as requested context. The assistant never passes as the
  human; there is no unmarked mode.
- **Everything visible.** Narrated live in the terminal (above); the sends
  are in `history` like any other message, so the record is permanent.

## What the asker sees (no feature needed on their side)

They just send mail. The reply lands visibly labelled as an assistant answer
(the in-body mark works even for plain readers); if they run cli-chat, their
own agent (per instructions) hands requested context to the task they're in
rather than reading it out ceremonially. Two auto-chat sessions = machines
clearing each other's questions while both humans work — with both terminals
narrating.

## Limits (state, don't oversell)

- **Answers only while a session with auto chat is running.** No session,
  no daemon, no answers — mail waits, as always. (Same boundary as PUSH.md.)
  "Permanent mediator" is a per-session posture, not an always-on service.
- **Answer quality = that machine's context.** The assistant answers from
  the repo it's sitting in and what it has learned; it says "I'll leave that
  for Sam" freely.
- **One session at a time** should run auto chat (the chat.lock already
  arbitrates the live-inbox surfacing; auto chat inherits it).

## Build map — shipped in 0.12.0 (together with HISTORY.md)

Everything below is BUILT (the machinery: tools, marker, self-send, quiet
lock, CLI send; the behaviour rides in CLAUDE.md + instructions + resultNotes
as planned). Kept as the map of where each piece lives:

1. **HISTORY.md ships first** — the grounding depends on it.
2. `cli-chat-context/`: paths + read/write helpers; "remember X" behaviour;
   read-at-start in every session (instructions + resultNote nudges).
3. Triggers + loop: "chat" offers auto once; "auto"/"manual" mid-flight;
   "auto chat" / "auto" shortcut → same `start_chat`/`chat_batch` machinery
   with **backlog drain on activation**, mediated disposal, live narration,
   ask-then-answer for the rest. Update the discovery tips to name both
   rungs (session-start summary hint: chat *and* auto chat — suggest only;
   the in-chat offer explains). (Behaviour-only where possible; the tools
   already exist.)
4. The assistant mark: `answered_by: "assistant"` in `packBody`/`unpackBody`
   + `draft_reply` param, **plus the visible in-body line** so unmarked
   recipients see it too; render assistant answers distinctly on the
   receiving side.
5. Rails in CLAUDE.md + instructions.ts + resultNotes: contacts-only,
   grounding stack, never-list, untrusted-body discipline, always-marked.
6. The enablers: verify/enable **self-send** (escalate-by-mail, self-to-self);
   **pending-questions** convention in `cli-chat-context/` (also tracks
   fan-out asks — who's answered, who hasn't); **CLI send subcommand**
   (`npx cli-chat-mcp send`) for headless bots — each small and independently
   shippable.
6b. **Quiet variant**: extend the `chat.lock` semantics (a mode marker in the
   lock) so the hook suppresses ordinary mail notices while quiet auto chat
   runs but passes escalation self-mail through with its own label; digest
   behaviour ("what did you handle?" + one-line recap on next engagement).
7. Tests: `answered_by` round-trip + back-compat; visible-mark presence on
   every auto-chat send; contacts-only gating; context read/write helpers;
   self-send surfacing. (The disposal rules are behavioural — verify with
   the e2e two-account script: backlog present at activation → drained and
   answered → question in → grounded assistant reply out, marked →
   ungroundable question escalates by mail → human's reply is passed on.)
8. README: one section — *say "auto chat" and your assistant answers your
   mail from your own context; every reply is marked as the assistant and
   shown as it happens.* Version bump, publish.
9. **Draft chat (0.13.0)** — the midway rung, added on user request:
   behaviour-only (CLAUDE.md + instructions.ts + the chat_batch/start_chat
   resultNotes + the discovery tips). No new machinery: same waker and
   `chat_batch`; approved drafts send through the existing `draft_reply`,
   unmarked (user-reviewed = the user's message).

## Open questions

0. ~~**Self-send mechanics.**~~ RESOLVED in 0.12.0: the server admission path
   accepts sender = recipient (verified by test); self-mail surfaces as
   "your assistant" (assistant escalations) or "Me" (notes to self), is never
   auto-tagged, and never saves the user as their own contact. The
   multi-device race (two devices drain one mailbox, first drain wins) is
   accepted for v1.
1. **Context in the vault?** Syncing `cli-chat-context/` would make the
   assistant's memory follow the user across devices — but the vault is
   server-readable, and this is distilled conversation content. Options:
   accept (same trade as contacts), encrypt just this blob client-side, or
   stay local-only. Decide when multi-device users actually ask for it.
2. **Per-contact trust later?** "Auto-answer anything from Niels, only
   project facts for others" — tags could carry it (`work` circle gets repo
   answers). Defer until real use shows the need.
3. **Answer budget?** A cap per sender per session (e.g. stop auto-replying
   to the 10th question from one contact and surface instead) as a
   runaway-loop guard when two assistants talk to each other — matters more
   once fan-out asks exist. Cheap, decide at build time.
4. **Fan-out etiquette.** The shared-doc replacement sends N messages at
   once; group send already requires showing the roster first — reuse that
   rule (assistant shows who it's about to ask, user confirms once)?
5. **"auto" collision?** The bare trigger "auto" is short — check it doesn't
   collide with other phrasing in practice ("auto-tag", "automatically …").
   Mid-chat it's unambiguous; as a cold opener, if it ever misfires, require
   the two-word form to start and keep bare "auto" for the in-chat flip.
