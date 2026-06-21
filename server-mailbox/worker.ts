// Cloudflare Workers entry point — the production deploy target. Same Hono app
// as the Node runner, backed by D1 instead of node:sqlite. Deploy with wrangler
// (see wrangler.toml). NOTE: not exercised by the local test suite; the Node
// runner (node.ts) is the verified dev path.

import { createApp } from "./app.ts";
import { d1Store, type D1Like } from "./store-d1.ts";
import { verifyRequest } from "./verify.ts";

// The Durable Object class must be exported from the Worker entry so the runtime
// can instantiate it (see wrangler.toml [[durable_objects.bindings]]).
export { Inbox } from "./inbox-do.ts";

export interface Env {
  DB: D1Like;
  INBOX: any; // DurableObjectNamespace (loose-typed to avoid workers-types dep)
}

// Retention windows for the daily cron sweep (see wrangler.toml [triggers]).
// Read mail lingers a week as a re-fetch grace; anything (read or not) older
// than a month is dropped, which also bounds never-drained spam.
const READ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export default {
  fetch(request: Request, env: Env, ctx: any): Response | Promise<Response> {
    const url = new URL(request.url);

    // WebSocket push subscription: verify the signed upgrade, then hand the
    // socket to the recipient's inbox Durable Object. (See /connect in PUSH.md.)
    if (url.pathname === "/connect") return handleConnect(request, env);

    const app = createApp({
      store: d1Store(env.DB),
      now: () => Date.now(),
      // After a message is stored, wake the recipient's connected sockets.
      // Fire-and-forget via waitUntil so it never delays the POST response, and
      // a missed wake is harmless (client has catch-up sync + fallback poll).
      notify: (recipient) => ctx.waitUntil(wake(env, recipient)),
    });
    return app.fetch(request, env as unknown as Record<string, unknown>, ctx);
  },

  // Cloudflare Cron Trigger: prune old mail so the mailbox can't grow without
  // bound. Idempotent and safe to run as often as the schedule fires.
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const now = Date.now();
    await d1Store(env.DB).purge(now - READ_TTL_MS, now - UNREAD_TTL_MS);
  },
};

// Authenticate the WebSocket upgrade with the same Ed25519 signed-header scheme
// as the HTTP routes, then route to idFromName(signPub). Because the id comes
// from the *verified* pubkey, a subscriber can only attach to its own inbox.
async function handleConnect(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket")
    return new Response("expected websocket upgrade", { status: 426 });

  const auth = await verifyRequest(
    (h) => request.headers.get(h),
    "GET",
    "/connect",
    "",
    Date.now(),
  );
  if (!auth.ok) return new Response(auth.reason, { status: 401 });

  const id = env.INBOX.idFromName(auth.pubkey);
  return env.INBOX.get(id).fetch(request);
}

// Best-effort wake of a recipient's inbox DO. Errors are swallowed — the client
// always has a catch-up sync on (re)connect and a slow fallback poll.
async function wake(env: Env, recipient: string): Promise<void> {
  try {
    const id = env.INBOX.idFromName(recipient);
    await env.INBOX.get(id).fetch("https://inbox/push", { method: "POST" });
  } catch {
    /* ignore */
  }
}
