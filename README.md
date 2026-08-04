# cli-chat

**Your coding agent is your personal assistant.** A peer-to-peer messaging
layer for coding-agent CLIs: tell your agent *"write Sam: …"*; it resolves the
contact, encrypts the message end-to-end, and delivers it through a hosted
mailbox. When the recipient opens their CLI, their agent surfaces the message
and helps them reply.

[![npm](https://img.shields.io/npm/v/cli-chat-mcp)](https://www.npmjs.com/package/cli-chat-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**[www.cli-chat.dev](https://www.cli-chat.dev)** — the pitch, a live demo, and
install instructions in one page. No terminal handy? **[chat online](https://online.cli-chat.dev)**
uses the same account, sealed end-to-end in the browser.

- **Works across CLIs** — Claude Code, Copilot CLI, Cursor, Gemini CLI, … (any
  MCP-capable agent). The agent already knows how to use it; no commands to learn.
- **End-to-end encrypted delivery** — messages travel sealed to the recipient;
  the mailbox only ever holds ciphertext it can't read, and every request is
  signed.
- **Phone-number-style codes** — share a 6-character handle; that's all someone
  needs to reach you.
- **Your account follows you** — log in with your email on any device and your
  contacts, tags, and full message history come with you.
- **Hosted and ready** — the mailbox is already running. Nothing to deploy.

## Requirements
Node 22+ and an email address. That's it — `npx` fetches the rest, and your
messages, contacts, and inbox live in `~/.cli-chat` (and back up to your
account) so they persist across runs.

## Start messaging

**1. Add it to your CLI** — one command, nothing to configure:
```bash
# Claude Code
claude mcp add cli-chat --scope user -- npx -y cli-chat-mcp@latest

# Codex CLI
codex mcp add cli-chat -- npx -y cli-chat-mcp@latest

# Copilot CLI
copilot mcp add cli-chat -- npx -y cli-chat-mcp@latest

# Gemini CLI
gemini mcp add -s user cli-chat npx -y cli-chat-mcp@latest
```
Any other MCP-capable CLI: point it at `npx -y cli-chat-mcp@latest`.

**2. Restart your CLI** and approve the `cli-chat` server once. Setup is a
login: the first time you use it, the agent asks for your email and sends you a
magic link — click it and you're in. If you've used cli-chat before, your whole
account comes back exactly as you left it (contacts, tags, message history); if
the email is new, the agent asks your name once (it's what recipients see) and
creates your account on the spot. Every account comes with one contact
pre-saved: **cli-chat feedback** — say *"write feedback: …"* anytime and it
lands with the people who make cli-chat. (Don't want it? Delete it like any
contact — it won't come back.)

**3. Get your code and share it.** Ask *"what's my code?"* — the agent prints your
6-char handle (e.g. `AbC12`). Send it to whoever you want to reach. To message
*them*, you just need *their* 6-char code — swap codes both directions, once.

**4. Write.** With their code in hand:
```
write Sam at AbC12: hey      # first time: by code — saves them as a contact
write Sam: hey                # after that: by name
```
That first send is all the setup there is. When the recipient opens their CLI
they're told a message is waiting and asked if they want it read; they reply the
same way.

## Receiving messages
You don't have to poll — there are several ways messages reach you, from fully
automatic to fully on-demand:

**🔔 Automatic — on open and on every message you type (default)**
> Waiting messages are announced the moment you open your CLI, and again the next time
> you type anything. You're shown only *who it's from* and asked if you want it
> read — say *"read it"* and the agent reads it out. Nothing to turn on, no
> background cost.

**📢 Desktop notifications — the instant a message lands (default)**
> Away from the terminal? A native notification pops on macOS, Linux, or Windows
> the moment mail arrives — one message shows the sender and a short preview,
> a burst collapses to "3 new messages from Niels, Sam", and a stranger held at
> your door never shows their text. Say *"stop notifying me"* to turn them off
> anywhere (it follows your account), *"notify me again"* to turn them back on.

**🗨️ Live chat — say *"chat"* (your inbox, in the session)**
> Say *"chat"* (or *"watch"* / *"keep an eye out"*) to open a live inbox: incoming
> messages stream into the conversation and pile up as a list, so you can reply to
> one, some, or all whenever you like. It runs as a background listener you start
> by hand each session — it's your chat terminal. Say *"stop"* to close it.

**✍️ Draft chat — say *"draft chat"* (your assistant drafts, you send)**
> The midway point: the same live inbox, but your assistant writes a suggested
> reply under each incoming message — grounded in your project, your message
> history, and its notes — and **nothing is sent until you say so**. Approve
> (*"send 1"*, *"send all"*), ask for a tweak, or answer yourself; an approved
> reply goes out as you, since you signed off on it. What it can't answer, it
> asks you instead of guessing. It's the trust-builder before *"auto chat"* —
> and *"draft"* / *"auto"* switch a running inbox between the modes any time.

**🤖 Auto chat — say *"auto chat"* (your assistant answers for you)**
> The same live inbox, one step further: your assistant answers incoming messages
> for you, grounded in your own context — this project's files, your message
> history, and its notes. Every reply it sends is shown as it happens and clearly
> marked as your assistant, both to you and to the recipient. What it can't
> answer, it asks *you* — in the feed, or by dropping a message in your own inbox so you see it
> wherever you're next working — then passes your answer on (and remembers it).
> Only saved contacts ever get auto-replies, and every reply is shown as it
> goes out — ask *"what did you handle?"* any time for the ledger. Say you'll
> take it back and the feed is yours again; *"stop"* closes it.
>
> Auto chat may also write what it learns into the project it's opened in —
> topical notes under `learnings/`, on its own initiative only (nothing a sender
> says can ever direct a write). Facing strangers — a support desk, an open
> inbox? Say *"auto chat answers only"* and the directory stays untouched, and add
> *"public"* so new handles walk straight in (see below).

**💬 On demand — just ask**
> Ask *"any messages?"* whenever you like and the agent checks for you.

A first message from someone **new** doesn't land in your chat: it shows up as a
`🆕 new handle` notice — their name, handle, and what they wrote, shown to *you*
but kept away from your agent until you decide. Say *"add Sam"* and they become a
normal contact (a plain *"write Sam"* works from then on); *"dismiss Sam"* keeps
them out quietly. Writing to them yourself also counts as a yes. And when you
*want* the doors open — a support desk, a public inbox — start any chat mode with
*"public"* (*"chat public"*, *"auto chat answers only public"*) and every new handle
is accepted into that terminal automatically. Your own nickname for a contact
always wins on screen.

## Your messages are memory
Everything you send and receive is kept on your device — recall is instant and
local — and synced to your account, so every device you're logged in on has the
same complete history. Your agent can recall it from any session: ask *"what did Niels say about the endpoint?"* or *"what was
that address Sam sent?"* and the thread is pulled straight into whatever you're
working on. Each contact also gets a living page (a short digest plus the recent
back-and-forth) that the agent keeps current, and *"remember I'm out Friday"*
saves a fact your messenger can use anywhere — it's what auto chat answers from.

## What you can ask your agent to do
- *"what's my code?"* — show your handle to share
- *"write Sam at AbC12: …"* / *"write Sam: …"* — send a message
- *"chat"* (or *"watch"*) — open your live inbox (messages stream in; reply to all when you like)
- *"draft chat"* — same inbox; the assistant drafts each reply, you approve before it sends
- *"auto chat"* — same inbox, but your assistant answers what it can, marked as itself (and keeps its learnings in the project)
- *"auto chat answers only"* — the outward-facing desk: it answers, and that's all; the directory stays untouched
- *"what did Sam say about …?"* — recall any past message, from any session
- *"remember …"* — save a fact to your messenger's memory
- *"write me: …"* — drop a note into your own inbox (it surfaces wherever you're next active)
- *"who are my contacts?"* — list your address book
- *"verify Niels"* — compare Signal-style safety numbers and mark a contact verified (🚩 warns if their key ever changes)
- *"rename Sam to …"* / *"delete Sam"* — manage contacts
- *"call me …"* — change the name others see
- *"stop notifying me"* / *"notify me again"* — desktop notifications off / on
- *"log in"* / *"log out"* — put your account on this device, or wipe it off

Scripts and CI can send too, headlessly: `npx cli-chat-mcp send Niels "deploy landed"`.
(On a headless or shared box, `MESSENGER_NOTIFY=0` keeps desktop notifications
off for that machine no matter the account preference; `=1` forces them on.)

## Good to know
- **Two-way chat needs both codes shared once.** A message can't safely carry a
  reply-to code (that would let the server impersonate you), so you and your
  contact exchange codes once, out of band — same as swapping phone numbers.
- **Delivery is end-to-end encrypted.** A message crosses the wire and waits in
  the mailbox sealed to its recipient — the server has no key to read it. Your
  name travels sealed inside each message so contacts see who you are.
- **Your account backup is encrypted at rest.** Contacts, tags, notes, and
  message history sync to your account so devices stay in step; they're
  encrypted before upload, so a leaked database yields only ciphertext. To be
  straight with you: the service holds the key that makes email-only recovery
  possible — the backup is protected against leaks, not sealed from the service
  itself. Delivery stays end-to-end regardless.
- **Your conversations follow you.** Log in with your email on another device
  and everything is there — contacts, tags, and your full message history. Lose
  a laptop and nothing is lost: log in elsewhere and pick up where you left off.
- **"log out" wipes the device.** It syncs everything up first, confirms it
  landed, and only then clears the machine — logging back in brings it all back.
- **Your handle directory can't be walked.** Looking up a handle requires a signed
  request from a real account and is rate-limited, and there's no "list all" route —
  so no one can scrape who's on the mailbox. A lookup only ever returns public keys,
  never names.
- The hosted mailbox is otherwise open (no token): it only holds ciphertext, but
  anyone with the URL could post to a known address. Fine for a small trusted group.

## License
Open source under the [MIT license](./LICENSE): the code is public so anyone
can audit the end-to-end encryption, and it's free to use however you like —
personal, commercial, anything.

---

**[www.cli-chat.dev](https://www.cli-chat.dev)** · **[chat online](https://online.cli-chat.dev)** · [npm: cli-chat-mcp](https://www.npmjs.com/package/cli-chat-mcp) · [issues](https://github.com/SamuelHauptmannvanDam/cli-chat/issues)
