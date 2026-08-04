# Project structure

Four independently-deployed pieces share one repo:

- `src/` — the Node CLI / MCP server (`cli-chat` bin). Talks to the local SQLite
  inbox cache, the filesystem-backed vault, and the hosted mailbox.
- `server-mailbox/` — the Cloudflare Worker + D1 backend. Sealed ciphertext only;
  never sees plaintext.
- `online/` — the browser client, bundled with esbuild into a static
  `online/public/app.js`.
- `site/` — the static marketing site. No code dependency on anything else here.

## The one structural rule

`src/core/` is the **platform-agnostic** subset of the CLI codebase — no
`node:*` builtins, no Node-only packages (`node-sqlite3-wasm`, etc.). It holds
the modules that genuinely need to run identically in Node, the Worker, and the
browser: crypto (`crypto.ts`), request signing (`auth.ts`, `canonical.ts`), the
mailbox/account HTTP clients (`mailbox-client.ts`, `account-client.ts`), handle
encoding (`key-code.ts`), and the wire message shape (`wire.ts`).

**`server-mailbox/` and `online/src/` may only reach into `src/` through
`src/core/`.** Never import another `src/` file directly (`db.ts`, `contacts.ts`,
`vault.ts`, and the rest of `src/` assume a Node filesystem and are not safe to
bundle into the Worker or the browser).

This is enforced by `test/unit/boundaries.test.ts`, which runs on every
`npm test`:
- fails if anything under `src/core/**` imports a Node builtin,
- fails if `server-mailbox/**` or `online/src/**` imports a `src/` file outside
  `src/core/**`.

If you need to share a new module across CLI/Worker/browser, add it to
`src/core/` (keep it dependency-free of Node APIs) rather than reaching across
with a one-off relative import — the boundary test will catch it if you forget.

## Design docs

Per-feature specs (auth/sync, groups, friends, live inbox, history, etc.) live
under `docs/`. `README.md`, `CLAUDE.md`, and `LICENSE` stay at the repo root.
