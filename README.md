# CLI Messenger

A peer-to-peer messaging layer for coding-agent CLIs. You tell your agent
*"write Sam: …"*; it resolves the contact, encrypts the message end-to-end, and
delivers it through a hosted mailbox. When the recipient opens their CLI, their
agent surfaces the message and helps them reply.

- **Works across CLIs** — Claude Code, Gemini CLI, Copilot CLI, Cursor, … (any
  MCP-capable agent). The agent already knows how to use it; no commands to learn.
- **End-to-end encrypted** — the mailbox only ever holds ciphertext, and every
  request is signed. Your messages are unreadable to the server.
- **Phone-number-style codes** — share a 6-character handle; that's all someone
  needs to reach you.
- **Hosted and ready** — the mailbox is already running. Nothing to deploy.

## Requirements
Node 22+. That's it — `npx` fetches the rest, and your identity, contacts, and
inbox live in `~/.cli-chat` so they persist across runs.

## Start messaging

**1. Add it to your CLI** — one command, nothing to configure:
```bash
# Claude Code
claude mcp add cli-chat --scope user -- npx -y cli-chat-mcp@latest

# Gemini CLI
gemini mcp add -s user cli-chat npx -y cli-chat-mcp@latest

# Copilot CLI
copilot mcp add cli-chat -- npx -y cli-chat-mcp@latest

# Codex CLI
codex mcp add cli-chat -- npx -y cli-chat-mcp@latest
```
Any other MCP-capable CLI: point it at `npx -y cli-chat-mcp@latest`.

**2. Restart your CLI** and approve the `cli-chat` server once. There's no setup
step — your identity is created the first time you need it (the agent asks your
name once so contacts see who you are).

**3. Get your code and share it.** Ask *"what's my code?"* — the agent prints your
6-char handle (e.g. `AbC123`). Send it to whoever you want to reach. To message
*them*, you just need *their* 6-char code — swap codes both directions, once.

**4. Write.** With their code in hand:
```
write Sam at AbC123: hey      # first time: by code — saves them, and auto-creates you
write Sam: hey                # after that: by name
```
That first send is all the setup there is. When the recipient opens their CLI
they're told a message is waiting and asked if they want it read; they reply the
same way.

## Receiving messages
You don't have to poll — there are three ways mail reaches you, from fully
automatic to fully on-demand:

**🔔 Automatic — on open and on every message you type (default)**
> Waiting mail is announced the moment you open your CLI, and again the next time
> you type anything. You're shown only *who it's from* and asked if you want it
> read — say *"read it"* and the agent reads it out. Nothing to turn on, no
> background cost.

**👀 Hands-free — `watch` (real-time)**
> Say *"watch"* and the agent keeps an eye out, reading new messages into the chat
> the instant they arrive. Great while you're waiting on a reply. Say *"stop"*
> when you're done.

**💬 On demand — just ask**
> Ask *"any messages?"* whenever you like and the agent checks for you.

A message from someone new shows their name and handle and saves them as a contact
automatically — so a plain *"write Sam"* works afterwards. Your own nickname for a
contact always wins on screen.

## What you can ask your agent to do
- *"what's my code?"* — show your handle to share
- *"write Sam at AbC123: …"* / *"write Sam: …"* — send a message
- *"watch"* — go hands-free
- *"who are my contacts?"* — list your address book
- *"rename Sam to …"* / *"delete Sam"* — manage contacts
- *"call me …"* — change the name others see

## Good to know
- **Two-way chat needs both codes shared once.** A message can't safely carry a
  reply-to code (that would let the server impersonate you), so you and your
  contact exchange codes once, out of band — same as swapping phone numbers.
- **Your messages are private to the server**, which only ever sees ciphertext.
  Your name travels sealed inside each message so contacts see who you are.
- **One identity per machine for now** — there's no way yet to move an identity to
  another device.
- **Your handle directory can't be walked.** Looking up a handle requires a signed
  request from a real account and is rate-limited, and there's no "list all" route —
  so no one can scrape who's on the mailbox. A lookup only ever returns public keys,
  never names.
- The hosted mailbox is otherwise open (no token): it only holds ciphertext, but
  anyone with the URL could post to a known address. Fine for a small trusted group.

## License
Source-available under the [PolyForm Noncommercial 1.0.0](./LICENSE) license: the
code is public so anyone can audit the end-to-end encryption, and it's free for
personal and other non-commercial use. Commercial use is reserved — reach out if
you'd like a commercial license.
