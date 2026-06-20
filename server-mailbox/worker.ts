// Cloudflare Workers entry point — the production deploy target. Same Hono app
// as the Node runner, backed by D1 instead of node:sqlite. Deploy with wrangler
// (see wrangler.toml). NOTE: not exercised by the local test suite; the Node
// runner (node.ts) is the verified dev path.

import { createApp } from "./app.ts";
import { d1Store, type D1Like } from "./store-d1.ts";

export interface Env {
  DB: D1Like;
}

export default {
  fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> {
    const app = createApp({ store: d1Store(env.DB), now: () => Date.now() });
    return app.fetch(request, env as unknown as Record<string, unknown>, ctx);
  },
};
