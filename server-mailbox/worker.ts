// Cloudflare Workers entry point — the production deploy target. Same Hono app
// as the Node runner, backed by D1 instead of node:sqlite. Deploy with wrangler
// (see wrangler.toml). NOTE: not exercised by the local test suite; the Node
// runner (node.ts) is the verified dev path.

import { createApp } from "./app.ts";
import { d1Store, type D1Like } from "./store-d1.ts";

export interface Env {
  DB: D1Like;
}

// Retention windows for the daily cron sweep (see wrangler.toml [triggers]).
// Read mail lingers a week as a re-fetch grace; anything (read or not) older
// than a month is dropped, which also bounds never-drained spam.
const READ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export default {
  fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> {
    const app = createApp({ store: d1Store(env.DB), now: () => Date.now() });
    return app.fetch(request, env as unknown as Record<string, unknown>, ctx);
  },

  // Cloudflare Cron Trigger: prune old mail so the mailbox can't grow without
  // bound. Idempotent and safe to run as often as the schedule fires.
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const now = Date.now();
    await d1Store(env.DB).purge(now - READ_TTL_MS, now - UNREAD_TTL_MS);
  },
};
