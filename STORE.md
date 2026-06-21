# Refactor plan: library shims → native Node APIs

Two places use a **third-party library instead of a native Node API**, on purpose,
to keep the install floor at **Node 20** (broadest reach, no native build, no
version traps). Both are isolated to a single file so they can be swapped to the
native API later with no ripple. This documents each and **when it's worth doing**.

| Concern | Library now (Node 20+) | Native API | Native needs | Isolated to |
|---|---|---|---|---|
| Inbox cache (SQLite) | `node-sqlite3-wasm` | `node:sqlite` | **Node 24+** | `src/db.ts` |
| WebSocket client (warmer) | `ws` | global `WebSocket` | **Node 22+** | `src/warmer.ts` |

---

## 1. Inbox cache: `node-sqlite3-wasm` → `node:sqlite`
Real SQLite in WebAssembly. Chosen because `node:sqlite` is only usable unflagged
on **Node 24+**, so `npx cli-chat-mcp` crashed with `ERR_UNKNOWN_BUILTIN_MODULE`
on the Node 22 LTS line. WASM "just installs and runs" on Node 20+, any OS, no
native build.

### Cost vs native (all negligible here except one)
| Cost | Impact at our scale |
|---|---|
| Weaker cross-process write locking (WASM VFS; WAL may not apply) | **The only real one** — server warmer + hook both touch `~/.cli-chat`; concurrent writes could race. Rare/short writes; mitigable with atomic writes. |
| ~1 MB wasm load + instantiate per process | Negligible (~few ms) |
| Slightly slower per query | Invisible — network dominates 100–1000× |
| +1 dep (~1 MB), small memory bump, third-party (not Node core) | Minor |

### Migration steps (all in `src/db.ts` unless noted)
1. Import: `node-sqlite3-wasm` → `import { DatabaseSync } from "node:sqlite"`.
2. `Mailbox` type: `InstanceType<typeof Database>` → `DatabaseSync`.
3. Constructor: `new Database(path)` → `new DatabaseSync(path)`.
4. Calls: array-param → prepared/variadic:
   `db.run(sql, [a,b])` → `db.prepare(sql).run(a,b)`; same for `.all` / `.get`.
5. `getMessage`: drop the `?? undefined` (native `get()` already returns `undefined`).
6. `package.json`: `engines.node` → `>=24`; remove `node-sqlite3-wasm`.
7. `README.md`: bump the Requirements line to Node 24+.

**Verify:** `npm test` (db.test.ts + integration must stay green — they exercise
the public API, so they validate either backend) and `npm run build`. No other
source file changes.

**Gain:** real WAL + OS-level cross-process locking (nicer for warmer+hook sharing
the cache). **Cost:** reinstating the Node 24 floor.

---

## 2. WebSocket client: `ws` → global `WebSocket`
The push warmer (`src/warmer.ts`) needs a WebSocket *client*. Node has no global
`WebSocket` until it landed experimentally in **Node 21** and on-by-default in
**Node 22**. We use the `ws` package so the warmer runs on **Node 20+**.

### ⚠️ This swap is NOT a drop-in — read before attempting
The native global `WebSocket` is the browser/WHATWG API, which **cannot set custom
request headers on the handshake.** Our `/connect` auth signs Ed25519 headers
(`x-pubkey` / `x-timestamp` / `x-signature`) on the upgrade — `ws` supports that
via `new WebSocket(url, { headers })`; the global API does **not**. So migrating to
native also requires **moving the signed auth off headers** (e.g. into the URL
query string) and updating the server's `/connect` verification to match. That's a
client *and* server change, not a one-file swap — which is why `ws` is the more
attractive default.

### Migration steps (if you do it anyway)
- **Server** (`server-mailbox/worker.ts` `handleConnect`): read `x-*` auth from
  query params instead of headers; build the canonical string over the same
  `(GET, /connect, ts, "")` and verify (`verify.ts` is reusable — just feed it the
  query values). Keep header support too if you want a transition window.
- **Client** (`src/warmer.ts`): replace `import WebSocket from "ws"` with the
  global; put the signed params in the URL (`/connect?pubkey=…&ts=…&sig=…`);
  translate the event API: `ws.on("open"/"message"/"close"/"error", …)` →
  `addEventListener(...)`, and read frames from `event.data` (not the raw arg).
- `package.json`: `engines.node` → `>=22`; remove `ws` + `@types/ws`.

**Verify:** deploy the worker, then confirm the warmer connects and a sent message
wakes it (watch the cache fill). `npm test` + `npm run build`.

**Gain:** one fewer dependency. **Cost:** Node 22 floor **and** the header→query
auth rewrite on both sides. Low payoff; see below.

---

## When does it make sense to do either?
Refactor on **two conditions together**, never on the Node version alone:

1. **The floor is safe to raise** — effectively your whole user base is already on
   Node 24+ (cache) / Node 22+ (WebSocket). Until then, raising it just breaks
   installs, which is exactly the bug we fixed.
2. **There's a concrete payoff**, e.g.:
   - **Dropping a dependency** for supply-chain / maintenance reasons (the library
     goes unmaintained, gets a CVE, etc.).
   - **node:sqlite specifically:** if the warmer + hook sharing the cache ever
     causes *real* lock contention or corruption, native WAL is the proper fix.
     (Watch for it; it's the one non-cosmetic reason.)
   - You want zero third-party runtime deps as a principle.

**What does NOT justify it:** performance. At this scale both shims are invisible
next to the network round-trip — don't refactor for speed.

### Worked example: when to set the floor to Node 22
Node 22 unlocks only one thing here: the built-in global `WebSocket`. So a Node 22
floor makes sense in exactly these cases:
- **Node 20 hits end-of-life (~April 2026).** Set your floor to the oldest Node LTS
  still in maintenance — when that's 22, bump `engines` to `>=22` purely for
  lifecycle hygiene. `ws` keeps working on 22, so this is a zero-code change; you're
  just dropping dead Node versions.
- **You want to drop the `ws` dependency.** 22 is the minimum that allows the
  `ws`→native swap above (plus the header→query auth rewrite).

Caveat: a 22 floor does **nothing** for the cache (native SQLite needs **24**). So
if you're raising the floor anyway, weigh going straight to 24 (covers both shims)
vs. 22 (covers only `ws` / Node-20 EOL).

### Recommendation today
- **SQLite:** defer. Only worth it once Node 24+ is a safe baseline *and* you hit
  real cross-process locking trouble. Then it's a clean one-file swap.
- **WebSocket:** defer harder. Saving one small pure-JS dep isn't worth the
  Node 22 floor **plus** rewriting auth from headers to query on both client and
  server. Keep `ws` unless you're dropping deps as a hard policy.

In short: both are deliberate, both are isolated, and **neither is worth doing
soon.** Revisit when a Node baseline is guaranteed *and* a dependency becomes a
liability — not before.
