# Refactor plan: library shims → native Node APIs

Floor is **Node 22**. One library shim remains, on purpose, isolated to a single
file so it can be swapped to the native API later with no ripple. This documents
it, records the WebSocket shim we already removed, and says **when** to do the
remaining swap.

| Concern | Now (Node 22) | Native API | Native needs | Isolated to | Status |
|---|---|---|---|---|---|
| WebSocket client (warmer) | native global `WebSocket` | — | Node 22 | `src/warmer.ts` | ✅ done |
| Inbox cache (SQLite) | `node-sqlite3-wasm` | `node:sqlite` | **Node 24+** | `src/db.ts` | ⏳ deferred |

---

## Remaining: inbox cache `node-sqlite3-wasm` → `node:sqlite`
Real SQLite in WebAssembly. Kept because `node:sqlite` is only usable unflagged on
**Node 24+**, and our floor is 22. WASM runs on 22 with no native build.

### Cost vs native (all negligible except one)
| Cost | Impact at our scale |
|---|---|
| Weaker cross-process write locking (WASM VFS; WAL may not apply) | **The only real one** — server warmer + hook both touch `~/.cli-chat`; concurrent writes could race. Rare/short writes; mitigable with atomic writes. |
| ~1 MB wasm load per process; slightly slower per query; +1 dep | Invisible — network dominates 100–1000× |

### Migration steps (all in `src/db.ts` unless noted)
1. Import: `node-sqlite3-wasm` → `import { DatabaseSync } from "node:sqlite"`.
2. `Mailbox` type: `InstanceType<typeof Database>` → `DatabaseSync`.
3. Constructor: `new Database(path)` → `new DatabaseSync(path)`.
4. Calls: array-param → prepared/variadic: `db.run(sql, [a,b])` → `db.prepare(sql).run(a,b)` (same for `.all` / `.get`).
5. `getMessage`: drop the `?? undefined` (native `get()` already returns `undefined`).
6. `package.json`: `engines.node` `>=22` → `>=24`; remove `node-sqlite3-wasm`.
7. `README.md`: bump the Requirements line to Node 24+.

**Verify:** `npm test` (db.test.ts + integration exercise the public API, so they
validate either backend) and `npm run build`. No other source file changes.

### When does it make sense?
Do it only when **both** are true:
1. **Node 24+ is a safe baseline** — effectively your whole user base is on 24+.
   Until then, raising the floor just breaks installs.
2. **There's a concrete payoff:** dropping the `node-sqlite3-wasm` dependency
   (supply-chain/maintenance), or — the one non-cosmetic reason — if the warmer +
   hook sharing the cache ever causes *real* cross-process lock contention, native
   WAL is the proper fix. Watch for it.

**Not** for speed — invisible at this scale. **Recommendation:** defer until Node
24 is guaranteed *and* a dependency/locking issue actually bites. Then it's a clean
one-file swap.

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
