// Cloudflare Workers entry point — the production deploy target. Same Hono app
// as the Node runner, backed by D1 instead of node:sqlite. Deploy with wrangler
// (see wrangler.toml). NOTE: not exercised by the local test suite; the Node
// runner (node.ts) is the verified dev path.

import { createApp } from "./app.ts";
import { d1Store, type D1Like } from "./store-d1.ts";
import { verifyRequest } from "./verify.ts";
import { resendSender } from "./email.ts";
import { makeStripeVerifier } from "./stripe.ts";

// The Durable Object class must be exported from the Worker entry so the runtime
// can instantiate it (see wrangler.toml [[durable_objects.bindings]]).
export { Inbox } from "./inbox-do.ts";

// A Cloudflare Rate Limiting binding: `.limit({ key })` → `{ success }`.
interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Like;
  INBOX: any; // DurableObjectNamespace (loose-typed to avoid workers-types dep)
  // Edge rate limiters (wrangler.toml [[unsafe.bindings]]). Optional so a deploy
  // without them configured still runs (the app fails open).
  RESOLVE_LIMITER?: RateLimiter;
  POST_IP_LIMITER?: RateLimiter;
  POST_KEY_LIMITER?: RateLimiter;
  // --- Account layer (AUTH-SYNC.md), all optional so a mailbox-only deploy still
  // boots; the account routes just 503 until these secrets are set. ----------
  RESEND_API_KEY?: string; // `wrangler secret put RESEND_API_KEY`
  EMAIL_FROM?: string; // verified Resend sender, e.g. "cli-chat <login@your.dev>"
  APP_BASE_URL?: string; // public origin for the magic-link verify URL
  CHECKOUT_URL?: string; // Stripe Payment Link for the one-time unlock
  STRIPE_WEBHOOK_SECRET?: string; // `wrangler secret put STRIPE_WEBHOOK_SECRET`
  FREE_SYNC?: string; // "1" → paywall off, online sync free for everyone (dormant billing)
}

// Map an app rate-limit bucket to its Cloudflare binding → "allow this request?".
// A missing binding fails OPEN (allow), matching the app's contract so a
// half-configured deploy never drops mail.
function makeRateLimit(env: Env) {
  const byBucket: Record<string, RateLimiter | undefined> = {
    resolve: env.RESOLVE_LIMITER,
    "post-ip": env.POST_IP_LIMITER,
    "post-key": env.POST_KEY_LIMITER,
  };
  return async (bucket: "resolve" | "post-ip" | "post-key", key: string): Promise<boolean> => {
    const limiter = byBucket[bucket];
    if (!limiter) return true;
    const { success } = await limiter.limit({ key });
    return success;
  };
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
      // After a vault push, wake the account's OTHER devices so they pull the new
      // version in real time. All of an account's devices share one signPub (the
      // vault carries the keypair), so this rides the same inbox DO as mail.
      notifyVault: (signPub) => ctx.waitUntil(wake(env, signPub, "vault")),
      rateLimit: makeRateLimit(env),
      // Account layer: wire email + billing only when their secrets are present,
      // so a deploy without them still serves the mailbox (account routes 503).
      sendEmail:
        env.RESEND_API_KEY && env.EMAIL_FROM
          ? resendSender(env.RESEND_API_KEY, env.EMAIL_FROM)
          : undefined,
      appBaseUrl: env.APP_BASE_URL,
      checkoutUrl: env.CHECKOUT_URL,
      verifyPayment: env.STRIPE_WEBHOOK_SECRET
        ? makeStripeVerifier(env.STRIPE_WEBHOOK_SECRET, () => Date.now())
        : undefined,
      // Paywall kill-switch: FREE_SYNC=1 makes online sync free for everyone.
      freeSync: env.FREE_SYNC === "1",
    });
    return app.fetch(request, env as unknown as Record<string, unknown>, ctx);
  },

  // Cloudflare Cron Trigger: prune old mail so the mailbox can't grow without
  // bound. Idempotent and safe to run as often as the schedule fires.
  async scheduled(_event: unknown, env: Env, _ctx: unknown): Promise<void> {
    const now = Date.now();
    const store = d1Store(env.DB);
    await store.purge(now - READ_TTL_MS, now - UNREAD_TTL_MS);
    // Also sweep the account layer: expired magic-link tokens and dead sessions.
    await store.purgeAuth(now);
  },
};

// Authenticate the WebSocket upgrade with the same Ed25519 signed-header scheme
// as the HTTP routes, then route to idFromName(signPub). Because the id comes
// from the *verified* pubkey, a subscriber can only attach to its own inbox.
async function handleConnect(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket")
    return new Response("expected websocket upgrade", { status: 426 });

  // Auth (same Ed25519 canonical string as the HTTP routes) may arrive as headers
  // OR in the query string — the native WebSocket client can't set headers, so it
  // signs into the query. Header wins if both are present.
  const url = new URL(request.url);
  const auth = await verifyRequest(
    (h) => request.headers.get(h) ?? url.searchParams.get(h),
    "GET",
    "/connect",
    "",
    Date.now(),
  );
  if (!auth.ok) return new Response(auth.reason, { status: 401 });

  const id = env.INBOX.idFromName(auth.pubkey);
  return env.INBOX.get(id).fetch(request);
}

// Best-effort wake of an inbox DO. `t` selects the frame: "mail" (new mail) or
// "vault" (the account's synced vault changed). Errors are swallowed — the client
// always has a catch-up sync on (re)connect and a slow fallback poll.
async function wake(env: Env, recipient: string, t: "mail" | "vault" = "mail"): Promise<void> {
  try {
    const id = env.INBOX.idFromName(recipient);
    const q = t === "mail" ? "" : `?t=${t}`;
    await env.INBOX.get(id).fetch(`https://inbox/push${q}`, { method: "POST" });
  } catch {
    /* ignore */
  }
}
