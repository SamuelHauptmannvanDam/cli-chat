# Tests

Three tiers, all on the Node built-in test runner (`node:test`) — no extra deps.
Node strips TypeScript natively, so `.ts` tests run directly.

```
test/
  helpers.ts          in-process mailbox + NetContext builders (shared)
  unit/               pure logic, no I/O        — *.test.ts
  integration/        wired components + HTTP    — *.test.ts
  e2e/                live scripts (manual)
```

## Layers

- **unit/** — one file per module: `canonical`, `crypto`, `key-code`, `contacts`,
  `db`, `auth`. No network, no disk (temp files only where a loader is tested).
- **integration/** — components wired together: the SQLite `store`, request
  `verify`, the full HTTP `app` (via `app.fetch`), the signing `mailbox-client`,
  and `roundtrip` — the whole `core-net` send → sync → read → reply loop over an
  in-process Hono mailbox with real sealed-box encryption.
- **e2e/** — `live-net.ts` (self-contained, run by `test:e2e`) and
  `live-net-mcp.ts`, which drives two real MCP server processes and needs a
  running mailbox (`npm run mailbox`) plus `users/sam` + `users/niels`.

## Running

```bash
npm test                 # unit + integration (the default suite)
npm run test:unit
npm run test:integration
npm run test:coverage    # same suite + line/branch/function report
npm run test:e2e         # in-process live round-trip
npm run test:mcp         # two MCP processes (needs a running mailbox)
```

Coverage currently sits at ~99% lines / ~92% branches across `src/` and
`server-mailbox/`. The runner isolates each file in its own process, so crypto
init and SQLite caches never leak between files.
