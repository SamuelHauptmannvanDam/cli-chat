// The hosted mailbox as a portable Hono app. Three routes from PLAN.md §6:
//   POST /messages       — store an encrypted blob (sender must sign)
//   GET  /mailbox         — count + metadata of waiting mail (recipient signs)
//   GET  /messages        — drain the blobs (recipient signs), marks fetched
//
// The server only ever handles ciphertext + public keys. It authenticates by
// signature; it cannot read bodies.

import { Hono } from "hono";
import { verifyRequest } from "./verify.ts";
import type { WireMessage } from "../src/identity.ts";
import type { Store } from "./store.ts";

export interface AppDeps {
  store: Store;
  now: () => number;
  // Optional push hook: called with the recipient's signPub after a message is
  // stored, so a transport can wake live subscribers. Omitted on the Node runner
  // (no Durable Objects); injected on Workers. Must not throw / block delivery.
  notify?: (recipient: string) => void;
  // New-sender throttle caps (see admission control below). Override per-app
  // (tests pin small values); otherwise env, then the defaults.
  limits?: {
    unknownPairHourly?: number;
    unknownRecipientHourly?: number;
    unknownSenderDaily?: number;
  };
  // Optional edge rate-limiter (the Cloudflare Workers Rate Limiting binding on
  // the deploy; absent on the Node runner). Given a bucket + key, returns true to
  // ALLOW and false to 429. Fails OPEN by contract: a missing limiter (Node) or
  // one that throws never blocks delivery — the admission caps are the real wall.
  // Buckets: "resolve" (per-IP directory scraping), "post-ip" (per-IP send
  // flood, checked before any crypto), "post-key" (per-sender send rate).
  rateLimit?: (bucket: "resolve" | "post-ip" | "post-key", key: string) => Promise<boolean>;
}

// Abuse limits. These are short text ciphertexts, so the caps are generous yet
// far below anything that would let one POST balloon the store. MAX_REQUEST_BYTES
// bounds the whole signed envelope; MAX_BODY_BYTES bounds the sealed ciphertext.
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 16 * 1024;

// New-sender admission caps (PLAN open Q#7). "Unknown" = a sender the recipient
// has never written to; once the recipient replies they're known and exempt.
//   - pair (hourly):      stops ONE stranger flooding ONE recipient.
//   - recipient (hourly): Sybil backstop — many fresh keys still hit one ceiling
//                         per recipient (kept deliberately low for a public net).
//   - sender (daily):     caps one identity's total COLD reach across everyone,
//                         so a single key can't trickle-spray the whole network.
const ADMISSION_WINDOW_MS = 60 * 60 * 1000; // rolling hour
const ADMISSION_DAY_MS = 24 * 60 * 60 * 1000; // rolling day (sender daily cap)
const DEFAULT_UNKNOWN_PAIR_HOURLY = 5;
const DEFAULT_UNKNOWN_RECIPIENT_HOURLY = 10;
const DEFAULT_UNKNOWN_SENDER_DAILY = 50;
function envInt(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { store, now, notify, rateLimit } = deps;
  const unknownPairHourly =
    deps.limits?.unknownPairHourly ??
    envInt("MAILBOX_UNKNOWN_PAIR_HOURLY") ??
    DEFAULT_UNKNOWN_PAIR_HOURLY;
  const unknownRecipientHourly =
    deps.limits?.unknownRecipientHourly ??
    envInt("MAILBOX_UNKNOWN_RECIPIENT_HOURLY") ??
    DEFAULT_UNKNOWN_RECIPIENT_HOURLY;
  const unknownSenderDaily =
    deps.limits?.unknownSenderDaily ??
    envInt("MAILBOX_UNKNOWN_SENDER_DAILY") ??
    DEFAULT_UNKNOWN_SENDER_DAILY;

  // Edge rate-limit helper. The client IP is Cloudflare's CF-Connecting-IP on the
  // deploy; absent locally → a shared "local" key (the limiter is usually absent
  // there anyway). Fail-open: no limiter, or a limiter that throws, ALLOWS.
  const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "local";
  async function limited(bucket: "resolve" | "post-ip" | "post-key", key: string): Promise<boolean> {
    if (!rateLimit) return false;
    try {
      return !(await rateLimit(bucket, key));
    } catch {
      return false; // never block on a limiter failure
    }
  }

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/messages", async (c) => {
    // Coarse per-IP flood gate FIRST — before reading the body or spending any
    // crypto — so a torrent of junk POSTs is dropped at the cheapest point.
    if (await limited("post-ip", clientIp(c)))
      return c.json({ error: "rate limited" }, 429);
    // Reject oversize bodies as cheaply as possible: trust Content-Length first
    // (avoids buffering the body), then re-check the bytes we actually read,
    // before spending any crypto on verification.
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_REQUEST_BYTES)
      return c.json({ error: "message too large" }, 413);
    const raw = await c.req.text();
    if (raw.length > MAX_REQUEST_BYTES)
      return c.json({ error: "message too large" }, 413);
    const auth = await verifyRequest(
      (h) => c.req.header(h),
      "POST",
      "/messages",
      raw,
      now(),
    );
    if (!auth.ok) return c.json({ error: auth.reason }, 401);

    // Per-identity send-rate gate, now that the signer is verified. Bounds how
    // fast one key can post regardless of recipient (the daily cold-reach cap
    // below is per-recipient-novelty; this is raw rate).
    if (await limited("post-key", auth.pubkey))
      return c.json({ error: "rate limited" }, 429);

    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    // The signer must be the declared sender — no spoofing someone else's name.
    if (msg.sender !== auth.pubkey)
      return c.json({ error: "sender does not match signer" }, 403);
    if (!msg.id || !msg.recipient || !msg.body)
      return c.json({ error: "missing fields" }, 400);
    if (msg.body.length > MAX_BODY_BYTES)
      return c.json({ error: "message too large" }, 413);
    // Only accept mail for a recipient who has actually claimed a handle. Stops
    // attackers spraying blobs at random/never-registered keys that would never
    // be drained (and so would pile up until the retention sweep).
    if (!(await store.isRegistered(msg.recipient)))
      return c.json({ error: "unknown recipient" }, 404);

    // New-sender admission (PLAN open Q#7). A sender the recipient has never
    // written to is throttled; replying to someone (or messaging them first)
    // makes them known and exempt. Counts run on the SERVER's receive time, so a
    // sender can't back-date created_at to slip the rolling window.
    const receivedAt = now();
    if (!(await store.isKnownSender(msg.recipient, msg.sender))) {
      const since = receivedAt - ADMISSION_WINDOW_MS;
      if ((await store.countRecentFromPair(msg.recipient, msg.sender, since)) >= unknownPairHourly)
        return c.json({ error: "rate limited: too many new messages to this recipient" }, 429);
      if ((await store.countRecentUnknown(msg.recipient, since)) >= unknownRecipientHourly)
        return c.json({ error: "rate limited: recipient is receiving too much new mail" }, 429);
      // Daily cold-reach cap: how many people this sender has cold-messaged in the
      // last day. Bounds one identity's total spray across the whole network,
      // which the per-recipient caps (each scoped to one inbox) never could.
      const sinceDay = receivedAt - ADMISSION_DAY_MS;
      if ((await store.countRecentSentToNew(msg.sender, sinceDay)) >= unknownSenderDaily)
        return c.json({ error: "rate limited: too many new people contacted today" }, 429);
    }

    await store.put(
      {
        id: msg.id,
        recipient: msg.recipient,
        sender: msg.sender,
        body: msg.body,
        tags: msg.tags ?? null,
        created_at: msg.created_at,
        in_reply_to: msg.in_reply_to ?? null,
      },
      receivedAt,
    );
    // Wake any live subscribers for this recipient (push). Best-effort.
    notify?.(msg.recipient);
    return c.json({ ok: true, id: msg.id });
  });

  app.get("/mailbox", async (c) => {
    const auth = await verifyRequest((h) => c.req.header(h), "GET", "/mailbox", "", now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    const summary = await store.summary(auth.pubkey);
    return c.json({ count: summary.length, messages: summary });
  });

  app.get("/messages", async (c) => {
    const auth = await verifyRequest((h) => c.req.header(h), "GET", "/messages", "", now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    const blobs = await store.drain(auth.pubkey, now());
    return c.json({ messages: blobs });
  });

  // Claim a short handle for your keys. Signed by the registrant; you can only
  // register a handle pointing to your OWN key.
  app.post("/register", async (c) => {
    const raw = await c.req.text();
    const auth = await verifyRequest((h) => c.req.header(h), "POST", "/register", raw, now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    let body: { handle?: string; signPub?: string; boxPub?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!body.handle || !body.signPub || !body.boxPub)
      return c.json({ error: "missing fields" }, 400);
    if (body.signPub !== auth.pubkey)
      return c.json({ error: "can only register your own key" }, 403);
    if (!/^[0-9A-Za-z]{6}$/.test(body.handle))
      return c.json({ error: "handle must be 6 letters/digits" }, 400);

    const result = await store.registerHandle(body.handle, body.signPub, body.boxPub, now());
    if (result === "taken") return c.json({ ok: false, reason: "taken" }, 409);
    return c.json({ ok: true, handle: body.handle });
  });

  // Resolve a handle → public keys. The values returned are public keys, but the
  // route is the one that turns a handle into a messageable key, so it's gated two
  // ways against directory harvesting (PLAN open Q#7): a per-IP rate limit (the
  // cheap pre-crypto wall), then a signed request — so only someone with a real
  // account can resolve at all, and anonymous scrapers are turned away outright.
  // There's no list endpoint, so even an account holder can only resolve handles
  // they already know, one at a time, under the rate cap. The path (handle and
  // all) is folded into the signature, matching how the client signs it.
  app.get("/resolve/:handle", async (c) => {
    if (await limited("resolve", clientIp(c)))
      return c.json({ error: "rate limited" }, 429);
    const path = new URL(c.req.url).pathname;
    const auth = await verifyRequest((h) => c.req.header(h), "GET", path, "", now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    const rec = await store.resolveHandle(c.req.param("handle"));
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(rec);
  });

  return app;
}
