# Library shims → native Node APIs

Floor is **Node 22**. One library shim remains, on purpose, isolated to a single
file so it carries no ripple. This documents it and records the WebSocket shim
we already removed.

| Concern | Now (Node 22) | Native API | Native needs | Isolated to | Status |
|---|---|---|---|---|---|
| WebSocket client (warmer) | native global `WebSocket` | — | Node 22 | `src/warmer.ts` | ✅ done |
| Inbox cache (SQLite) | `node-sqlite3-wasm` (Node 22/23) **+** `node:sqlite` (Node 24+) | dual-driver, auto-selected | — | `src/db.ts` | ✅ done |

---

## Done: inbox cache → dual-driver (`node-sqlite3-wasm` + `node:sqlite`)
The locking risk this doc flagged as "the only real one" **bit us**: the warmer
holds the inbox open for the whole session, and `node-sqlite3-wasm`'s VFS can't
share a file across processes — so the separate `check-inbox` hook process got
`SQLITE_CANTOPEN`, exited silently, and never surfaced mail that arrived
mid-session. Native WAL was indeed the proper fix.

But we did **not** raise the floor. Instead `src/db.ts` now picks a driver at
runtime behind one `Store` interface, so the Node 22 base still works:

| Driver | When | Behaviour |
|---|---|---|
| `node:sqlite` (native) | Node **24+** (or `MESSENGER_DB_DRIVER=native`) | One persistent **WAL** handle. Native locking lets the server *and* the hook open the same file at once. The clean fix. |
| `node-sqlite3-wasm` | Node **22/23** (or `MESSENGER_DB_DRIVER=wasm`) | **open → use → close per op** + bounded retry, so no process hogs the file and the hook interleaves. `:memory:` keeps one handle (can't reopen per-op). |

Driver selection is by Node major version; `MESSENGER_DB_DRIVER=wasm|native`
forces one (used to test both paths). Everything above `db.ts` — the helpers,
`core-net.ts`, the warmer, the watch loop, the hook — is unchanged: they all go
through `openMailbox()` and `.run/.all/.get`.

**Verified:** `npm test` 96/96 on both drivers; a 12-way concurrent cross-process
stress test passes on both (no `CANTOPEN`); live push e2e against the hosted
worker passes.

---

## Done: WebSocket client `ws` → native global `WebSocket`
We removed the `ws` dependency and use Node's built-in `WebSocket` (Node 22+).

**The catch we had to handle:** the native (WHATWG) `WebSocket` can't set request
headers on the handshake, but `/connect` auth is an Ed25519-signed request. So the
auth moved **from headers into the URL query** — same canonical string
(`GET\n/connect\n<ts>\n`), just carried as `?x-pubkey=…&x-timestamp=…&x-signature=…`.
The server (`server-mailbox/worker.ts` `handleConnect`) reads each value from the
header **or** the query (`request.headers.get(h) ?? url.searchParams.get(h)`), so
both transports verify through the same `verify.ts`. The client builds the signed
query in `src/warmer.ts`.

This is why the project requires **Node 22** rather than 20: native `WebSocket` is
the floor. (It does nothing for the cache — that still needs 24.)
