# CLI Messenger

A peer-to-peer messaging layer for coding-agent CLIs. You tell your agent
*"write Sam: …"*; it resolves the contact, encrypts the message end-to-end, and
delivers it through a hosted mailbox. When the recipient opens their CLI, their
agent surfaces the message and helps them reply.

- **Works across CLIs** — Claude Code, Gemini CLI, Copilot CLI, Cursor, … (any
  MCP-capable agent). Behavior ships inside the server's MCP `instructions`.
- **End-to-end encrypted** — libsodium sealed boxes; the mailbox only ever holds
  ciphertext. Every request is Ed25519-signed.
- **Phone-number-style codes** — share a 6-character handle; a server registry
  maps it to your keys.
- **Hosted mailbox** — Cloudflare Worker + D1 (store-and-forward), already
  deployed; runs on Node locally too.

See [PLAN.md](./PLAN.md) for the full concept and roadmap.

## Requirements
Node 20+ (the inbox cache uses `node-sqlite3-wasm` — WebAssembly SQLite, no
native build). That's all an end user needs — `npx` fetches the rest. State
(identity, contacts, inbox cache) lives in `~/.cli-chat`, not next to the code, so
it survives across `npx` runs.

## Set up to message someone (no clone)

**1. Wire up your CLI** — add one MCP server entry. On Claude Code:
```bash
claude mcp add cli-chat --scope user \
  --env MESSENGER_MAILBOX_URL=https://mailbox.cli-chat-mcp.workers.dev \
  -- npx -y cli-chat-mcp
```
Or paste this into any MCP-capable CLI's config (Gemini, Cursor, Codex, …):
```json
{
  "mcpServers": {
    "cli-chat": {
      "command": "npx",
      "args": ["-y", "cli-chat-mcp"],
      "env": { "MESSENGER_MAILBOX_URL": "https://mailbox.cli-chat-mcp.workers.dev" }
    }
  }
}
```
(From a clone, `npm run install-clis` auto-writes this entry for every detected CLI.)

**2. Restart your CLI**, approve the `cli-chat` server once, then say *"set me
up"* — `create_account` mints your identity and prints your 6-char code (e.g.
`dC0v6m`) to share.

**3. Swap 6-char codes** with whoever you're messaging (both directions).

**4. Message:**
```
write Sam at dC0v6m: hey      # first time: by code (saves them)
write Sam: hey                # after that: by name
```
When the recipient opens their CLI they're told a message is waiting and asked if
they want it read; they reply the same way.

## Develop from a clone
```bash
npm install
npm test          # unit + integration (92 checks): encryption, server-only-ciphertext, spoofing
npm run test:mcp  # real MCP server processes against the live cloud mailbox
npm run build     # bundle src/ → dist/ (what gets published)
```
Running from a checkout keeps state in the repo's `users/` dir (back-compat);
set `MESSENGER_HOME` to override where state lives.

> Two-way chat needs both codes shared once — a message can't safely carry a
> reply-to key (that would let the server MITM). Mutual, out-of-band exchange is
> the secure choice.

## The MCP tools
`create_account` · `send_message` · `messages_available` · `watch` ·
`read_message` · `draft_reply` · `add_contact` · `my_key` · `list_contacts`.
Behavior (when to check, how to reply) is carried in the server's MCP
`instructions`, so it's the same in every CLI.

- **`create_account`** mints your identity + 6-char code from inside the CLI, so
  you don't need `npm run init` first. The server now boots even with no identity
  on the device — until you have one, the other tools report `no_account` and the
  agent offers to run `create_account`.
- **`watch`** is a cross-CLI watch loop: it long-polls ~25s for new mail (marking
  it read) and the agent re-calls it to keep watching. It needs no OS service and
  works in any MCP CLI, but it's not silent — each return is a turn you see.

## Receiving: on-open or on-demand
- **On open** — Claude Code runs a `SessionStart` hook (`src/check-inbox.ts`)
  that pulls waiting mail and tells you how many are waiting and from whom, then
  offers to read them (the bodies stay private to the agent until you say yes).
  Other CLIs check on their first turn (via the server instructions).
- **On demand** — ask "any messages?" anytime, or have the agent `watch` to
  long-poll for new mail while you wait.

## Layout
| Path | Role |
|---|---|
| `src/server-net.ts` | the MCP server (tools + `instructions`) |
| `src/core-net.ts` | seal-on-send, drain+decrypt-to-cache, read locally |
| `src/crypto.ts` · `auth.ts` · `canonical.ts` | sealed boxes + signed-request auth |
| `src/key-code.ts` · `identity.ts` · `contacts.ts` · `db.ts` | codes, identity, contacts, local cache |
| `src/mailbox-client.ts` | signed HTTP client |
| `src/init-identity.ts` · `install.ts` · `add-contact.ts` | onboarding helpers |
| `src/check-inbox.ts` | on-open read (SessionStart hook) |
| `server-mailbox/` | the Hono mailbox: `app.ts`, `node.ts` (local), `worker.ts`+`wrangler.toml` (Cloudflare/D1), `store*.ts`, `verify.ts`, `schema.sql` |
| `test/live-net.ts` · `live-net-mcp.ts` | in-process + real-MCP tests |

## Deploy your own mailbox (optional)
The mailbox is already deployed. To run your own:
```bash
npx wrangler d1 create cli-chat          # put the id in wrangler.toml
npx wrangler d1 execute cli-chat --remote --file server-mailbox/schema.sql
npm run deploy
```
Point clients at it with `MESSENGER_MAILBOX_URL=https://…`.

## Notes
- **Storage is keyed by handle, not name.** Each identity lives in
  `users/<handle>/` (your 6-char code), and the device default `users/.current`
  holds that handle. Your name is a cosmetic `name` field inside `identity.json`
  — local only, never sent to the server, and free to change. `MESSENGER_USER`
  accepts a handle, a display name, or a `signPub` and resolves to the right
  identity. Upgrading from the older name-keyed layout? Run `npm run migrate`
  (it claims a handle for any identity missing one, renames the dirs, and fixes
  `.current`). After migrating, restart any running CLI so its server reloads.
- **Secrets:** `users/*/identity.json` holds private keys and is gitignored; only
  public keys ever leave your machine.
- The deployed mailbox is currently open (no API token) — it only holds
  ciphertext, but anyone with the URL could post blobs to a known address. Fine
  for a small trusted group; add a token / rate-limiting before wider use.
- One identity per machine for now (no recovery-passphrase yet, so you can't move
  an identity to another device).
