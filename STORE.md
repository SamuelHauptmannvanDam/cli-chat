# Inbox cache backend — current choice & migration plan

The **local inbox cache** (`src/db.ts`) — each user's on-disk store of decrypted
recent messages — is deliberately swappable behind one type and six functions.
This documents the current backend and how to migrate it later.

## Current: `node-sqlite3-wasm` (Node 20+)
Real SQLite compiled to WebAssembly. Chosen because the built-in `node:sqlite` is
only usable **unflagged on Node 24+**, so `npx cli-chat-mcp` crashed with
`ERR_UNKNOWN_BUILTIN_MODULE` on the Node 22 LTS line. WASM "just installs and
runs" on Node 20+, every OS, with no native build.

### What it cost us (vs native node:sqlite)
| Cost | Impact at our scale |
|---|---|
| Cross-process write locking is weaker (WASM VFS; WAL may not apply) | **The only real one** — server + hook both touch `~/.cli-chat`; concurrent writes could race. Rare (writes are short/infrequent), mitigable with atomic writes. |
| ~1 MB wasm load + instantiate per process (~few ms) | Negligible |
| Slightly slower per query | Invisible — network round-trip dominates 100–1000× |
| +1 dependency (~1 MB), small memory bump, third-party (not Node core) | Minor |

Net: one mitigable tradeoff (locking) for "works for most users." See the cost
discussion in chat / `PUSH.md` concurrency note.

## The isolation that makes migration cheap
Nothing outside `db.ts` imports a SQLite library. Consumers (`core-net.ts`,
`server-net.ts`, `check-inbox.ts`, tests) use only:
- the `Mailbox` type (`export type Mailbox = …`), and
- `openMailbox · insertMessage · unreadFor · getMessage · markFetched · markRead`.

So the backend lives behind one file + one type. `test/unit/db.test.ts` exercises
that API directly, so it validates **any** backend unchanged — your regression
guard for a swap.

## Migration plan: WASM → native `node:sqlite` (when Node 24+ is a safe baseline)

**When to do it:** once you're comfortable requiring Node 24+ (the whole user base
on 24+). Gain: real WAL + OS-level cross-process locking (nicer for the push
warmer + hook sharing the cache). Cost: reinstating the Node 24 floor — Node 20/22
users break again.

**Steps — all in `src/db.ts` unless noted:**
1. Import: `import sqlite from "node-sqlite3-wasm"` → `import { DatabaseSync } from "node:sqlite"`.
2. `Mailbox` type: `InstanceType<typeof Database>` → `DatabaseSync`.
3. Constructor: `new Database(path)` → `new DatabaseSync(path)`.
4. Calls: array-param form → prepared/variadic form:
   - `db.run(sql, [a, b])` → `db.prepare(sql).run(a, b)`
   - `db.all(sql, [a])` → `db.prepare(sql).all(a)`
   - `db.get(sql, [a])` → `db.prepare(sql).get(a)`
5. `getMessage`: drop the `?? undefined` — native `get()` already returns `undefined` on a miss.
6. `package.json`: `engines.node` `>=20` → `>=24`; remove the `node-sqlite3-wasm` dependency.
7. `README.md`: bump the "Requirements" line back to Node 24+.

**Verify:** `npm test` (db.test.ts + integration must stay green) and `npm run
build`. No other source files change — that's the point of the abstraction.

## Optional: support both (auto-detect)
If you want broad compatibility *and* native performance where available, `db.ts`
can try `node:sqlite` and fall back to WASM:
```ts
let backend;
try { backend = await import("node:sqlite"); }      // Node 24+
catch { backend = await import("node-sqlite3-wasm"); } // everyone else
```
Wrap both behind the same `Mailbox` type + six functions. More code in `db.ts`,
but still zero ripple elsewhere, and no Node floor above 20.
