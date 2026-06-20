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
Node 23+ (uses built-in `node:sqlite` + native TypeScript). `npm install` pulls
`@modelcontextprotocol/sdk`, `hono`, `@hono/node-server`, `libsodium-wrappers`, `zod`.

## Quick test (no setup)
```bash
npm install
npm test          # in-process: encryption, server-only-ciphertext, spoof rejection (14 checks)
npm run test:mcp  # real MCP server processes against the live cloud mailbox
```

## Set up to message someone

**1. Install + create your identity** (one-time per machine):
```bash
npm install
export MESSENGER_USER=sam        # your handle/name
node src/init-identity.ts        # prints your 6-char code, e.g. dC0v6m
```

**2. Wire up your CLI(s):**
```bash
node src/install.ts              # writes MCP config for each detected CLI
```
Then restart your CLI and approve the `cli-chat` server once. (On Claude
Code you can instead use the bundled `.mcp.json` — both work.)

**3. Swap 6-char codes** with whoever you're messaging (both directions).

**4. Message** — launch your CLI with `MESSENGER_USER` exported:
```
write Sam at dC0v6m: hey      # first time: by code (saves them)
write Sam: hey                # after that: by name
```
The recipient's message auto-reads when they open their CLI; they reply the same way.

> Two-way chat needs both codes shared once — a message can't safely carry a
> reply-to key (that would let the server MITM). Mutual, out-of-band exchange is
> the secure choice.

## The MCP tools
`create_account` · `send_message` · `messages_available` · `listen_for_messages` ·
`read_message` · `draft_reply` · `add_contact` · `my_key` · `list_contacts` ·
`enable_auto_delivery` · `disable_auto_delivery` · `delivery_status`. Behavior
(when to check, how to reply, offering auto-delivery) is carried in the server's
MCP `instructions`, so it's the same in every CLI.

- **`create_account`** mints your identity + 6-char code from inside the CLI, so
  you don't need `npm run init` first. The server now boots even with no identity
  on the device — until you have one, the other tools report `no_account` and the
  agent offers to run `create_account`.
- **`listen_for_messages`** is a cross-CLI listening loop: it long-polls ~25s for
  new mail (marking it read) and the agent re-calls it to keep listening. Unlike
  the background watcher it needs no OS service and works in any MCP CLI, but it's
  not silent — each return is a turn you see.

## Receiving: on-open, on-demand, or automatic
- **On open** — Claude Code runs a `SessionStart` hook (`src/check-inbox.ts`)
  that pulls + reads waiting mail aloud. Other CLIs check on their first turn
  (via the server instructions).
- **On demand** — ask "any messages?" anytime.
- **Automatic** — a background watcher polls every 10s, pulls into your local
  cache, and desktop-notifies you even with no CLI open:
  ```bash
  npm run watch                  # foreground, in a spare tab
  ```
  …or have the agent install it as a background service: *"turn on automatic
  delivery"* → `enable_auto_delivery` (launchd/systemd/Task Scheduler). It
  *notifies* you; it can't make the agent speak unprompted (that's Phase 4).

## Layout
| Path | Role |
|---|---|
| `src/server-net.ts` | the MCP server (tools + `instructions`) |
| `src/core-net.ts` | seal-on-send, drain+decrypt-to-cache, read locally |
| `src/crypto.ts` · `auth.ts` · `canonical.ts` | sealed boxes + signed-request auth |
| `src/key-code.ts` · `identity.ts` · `contacts.ts` · `db.ts` | codes, identity, contacts, local cache |
| `src/mailbox-client.ts` | signed HTTP client |
| `src/init-identity.ts` · `install.ts` · `add-contact.ts` | onboarding helpers |
| `src/check-inbox.ts` · `watch.ts` · `service.ts` | on-open read, watcher, background service |
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
- **Secrets:** `users/*/identity.json` holds private keys and is gitignored; only
  public keys ever leave your machine.
- The deployed mailbox is currently open (no API token) — it only holds
  ciphertext, but anyone with the URL could post blobs to a known address. Fine
  for a small trusted group; add a token / rate-limiting before wider use.
- One identity per machine for now (no recovery-passphrase yet, so you can't move
  an identity to another device).
