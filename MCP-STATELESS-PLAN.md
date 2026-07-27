# Plan: MCP 2026-07-28 stateless protocol migration

**This is a PLAN, not shipped behavior** — delete it (or fold what shipped into
the regular docs) once Phase 1 lands. Written 2026-07-28, the day the spec
went final.

## What changed in the spec

The 2026-07-28 MCP revision makes the protocol stateless-first:

- **SEP-2575** removes the `initialize`/`initialized` handshake. Protocol
  version, client info and client capabilities travel in `_meta` on every
  request; server capabilities + `instructions` move to an on-demand
  `server/discover` RPC that clients MAY call (no longer guaranteed).
- **SEP-2567** removes protocol-level sessions (`Mcp-Session-Id`). State
  crossing calls is carried by explicit server-minted handles in tool payloads
  (our `login` poll_id already is this pattern).
- Roots, Sampling, Logging deprecated (≥12 months to removal); `ping`,
  resumable SSE, `resources/subscribe` removed. We use none of them.
- Applies to stdio too, deliberately — one protocol across transports.

## Why we're barely exposed

cli-chat's state (contact book, cache, threads, warmer) lives on disk and in
the long-lived stdio process — application state, not protocol state. The
waker, inbox rider and desktop notifications are outside MCP entirely. The
one protocol feature we lean on is `instructions` (server-net.ts, single
source in instructions.ts), and load-bearing behavior already rides
resultNotes + the user-side CLAUDE.md precisely because clients may drop
instructions — the new spec makes that policy mandatory in spirit.

## Compatibility (nothing breaks on spec day)

| Client | Us on SDK 1.x (old protocol) | Us on SDK 2.x (dual-mode) |
|---|---|---|
| Existing clients (old protocol) | works, unchanged | works — server still answers `initialize` |
| Updated dual-version clients | works — probe `server/discover`, get `Method not found`, fall back to `initialize` (mandated by SEP-2575) | works natively |
| Hypothetical new-protocol-only client | fails — but none will exist for 12+ months | works |

## Phases

### Phase 0 — done 2026-07-28
- [x] `serverInfo` version read from package.json instead of the stale
      hardcoded `"0.19.0"` (esbuild inlines it; JSON import works under
      direct `node src/server-net.ts` too).

### Phase 1 — migrate. Trigger: `@modelcontextprotocol/sdk` **2.0 stable**
As of 2026-07-28: new protocol is in `2.0.0-beta.5` (implements the final
wire spec: `serverInfo` in response `_meta`, `server/discover`, era
detection via `ConnectOptions.prior`). Do NOT chase betas; wait for stable.

- [ ] Bump SDK to 2.0 stable; run the codemod the SDK ships if applicable.
- [ ] Verify dual-mode: e2e suite against an old-protocol client AND one
      smoke test via a new-protocol client (`server/discover` returns our
      capabilities + instructions; legacy `initialize` still answered).
- [ ] Confirm `instructions` (INSTRUCTIONS + identityBlurb) surfaces via
      `server/discover`.
- [ ] If the 2.x API takes a callback for discover responses, compute
      `identityBlurb` per call instead of once at boot — login/rename then
      refreshes without a server restart.

### Phase 2 — hold dual-mode (ongoing, zero work)
Keep answering legacy `initialize` indefinitely — "works in ANY MCP client"
is the product promise and dual-mode is SDK-maintained code.

### Phase 3 — optional, unblocked by the new spec (not required)
Stateless HTTP MCP endpoint on the mailbox Worker: per-request auth token as
the state handle, no sticky sessions. Gives install-free access
(claude.ai, Slack, anything) and pairs with online.cli-chat.dev. Separate
design doc when/if picked up.
