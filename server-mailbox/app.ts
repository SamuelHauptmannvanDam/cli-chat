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
import type { AccountRecord, Store } from "./store.ts";
import { randomToken, sha256hex } from "./token.ts";
import { magicLinkEmail, type SendEmail } from "./email.ts";

export interface AppDeps {
  store: Store;
  now: () => number;
  // Optional push hook: called with the recipient's signPub after a message is
  // stored, so a transport can wake live subscribers. Omitted on the Node runner
  // (no Durable Objects); injected on Workers. Must not throw / block delivery.
  notify?: (recipient: string) => void;
  // Optional push hook called with the account's signPub after its vault is
  // updated, so other logged-in devices of that account pull the new version in
  // real time. Same transport as `notify` (the signPub inbox DO); omitted on the
  // Node runner. Must not throw / block the response.
  notifyVault?: (signPub: string) => void;
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

  // --- Account layer (AUTH-SYNC.md) -----------------------------------------
  // Outbound email for magic links. Absent on the Node runner / tests, where the
  // login response instead carries `devLink` (see exposeMagicLink) so the flow is
  // exercisable without a real mailbox. On the Worker this is the Resend sender.
  sendEmail?: SendEmail;
  // Public base URL the email link points back at (…/auth/verify). Falls back to
  // the request origin when omitted.
  appBaseUrl?: string;
  // Dev/test escape hatch: return the magic link in the /auth/login response so a
  // headless flow can "click" it. NEVER set in production — it bypasses email.
  exposeMagicLink?: boolean;
  // Stripe (or any provider) checkout link for the one-time unlock. The account
  // id is appended as client_reference_id so the webhook knows who paid.
  checkoutUrl?: string;
  // Verify a billing webhook payload and extract which account was paid. Injected
  // on the Worker (Stripe signature check); absent on Node (no billing in tests).
  verifyPayment?: (rawBody: string, signature: string | null) => Promise<{ accountId: string } | null>;
  // Kill-switch for the paywall: when true, the vault routes skip the `paid` gate
  // so online login/sync is FREE for everyone (billing stays wired but dormant).
  // Set via the FREE_SYNC env var on the Worker. Flip off to re-enable the €1 gate.
  freeSync?: boolean;
}

// Account-layer lifetimes. A magic link is short-lived; a session is long so a
// device stays logged in (renewed on next login). Both are overridable per app.
const LOGIN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const MAX_VAULT_BYTES = 512 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const { store, now, notify, notifyVault, rateLimit, freeSync } = deps;
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
    let body: { handle?: string; signPub?: string; boxPub?: string; name?: string };
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

    // `name` is the owner's public self-name (it already rides every message);
    // stored so contacts-of-contacts can show them by their own name. Bounded.
    const name = typeof body.name === "string" ? body.name.slice(0, 120) : undefined;
    const result = await store.registerHandle(body.handle, body.signPub, body.boxPub, now(), name);
    if (result === "taken") return c.json({ ok: false, reason: "taken" }, 409);
    return c.json({ ok: true, handle: body.handle });
  });

  // ==========================================================================
  // Contacts of contacts (CONTACTS-OF-CONTACTS.md): the second-degree graph.
  // Signed by the local identity (like the mailbox routes) — no account needed,
  // so everyone contributes edges and everyone can read their own network.
  // ==========================================================================
  const MAX_EDGES_BATCH = 2000; // bounds a backfill push
  const NETWORK_LIMIT = 50; // cap on returned second-degree people

  // Record that you saved a contact (or a batch, for the one-time backfill).
  // owner = the VERIFIED pubkey, so you can only ever add your own edges.
  app.post("/edges", async (c) => {
    const raw = await c.req.text();
    const auth = await verifyRequest((h) => c.req.header(h), "POST", "/edges", raw, now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    let body: { contact?: string; contacts?: string[] };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const list = (body.contacts ?? (body.contact ? [body.contact] : []))
      .filter((x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x))
      .slice(0, MAX_EDGES_BATCH);
    if (!list.length) return c.json({ error: "no valid contacts" }, 400);
    await store.addEdges(auth.pubkey, list, now());
    return c.json({ ok: true, added: list.length });
  });

  // Drop one edge when you delete a contact.
  app.delete("/edges", async (c) => {
    const raw = await c.req.text();
    const auth = await verifyRequest((h) => c.req.header(h), "DELETE", "/edges", raw, now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    let body: { contact?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!body.contact) return c.json({ error: "missing contact" }, 400);
    await store.removeEdge(auth.pubkey, body.contact);
    return c.json({ ok: true });
  });

  // Your contacts of contacts: your contacts' contacts, minus your own, ranked by
  // shared count. Only your own network (owner = verified pubkey).
  app.get("/network", async (c) => {
    const auth = await verifyRequest((h) => c.req.header(h), "GET", "/network", "", now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    const people = await store.contactsOfContacts(auth.pubkey, NETWORK_LIMIT);
    return c.json({ ok: true, people });
  });

  // Quiet opt-out: never surface me in anyone's results. Signed = only yourself.
  app.post("/edges/hidden", async (c) => {
    const auth = await verifyRequest((h) => c.req.header(h), "POST", "/edges/hidden", "", now());
    if (!auth.ok) return c.json({ error: auth.reason }, 401);
    await store.hideFromNetwork(auth.pubkey, now());
    return c.json({ ok: true });
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

  // ==========================================================================
  // Account layer (AUTH-SYNC.md): magic-link login + bearer-gated vault sync.
  // Separate from the signature-authed mailbox above — these use a session token,
  // and the vault they guard is server-readable (email is the recovery anchor).
  // ==========================================================================
  const { sendEmail, exposeMagicLink, checkoutUrl, verifyPayment } = deps;

  // Resolve a Bearer session token → its account, or 401. Used by the vault
  // routes. The token is hashed before lookup (DB stores only hashes).
  async function requireSession(c: {
    req: { header: (n: string) => string | undefined };
  }): Promise<AccountRecord | null> {
    const auth = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return null;
    return (await store.accountBySession(await sha256hex(m[1]!), now())) ?? null;
  }

  // Start a login: email a single-use magic link, hand the CLI a poll id. Creates
  // the account on first sight of an email. Rate-limited per IP (reuses post-ip).
  app.post("/auth/login", async (c) => {
    if (await limited("post-ip", clientIp(c)))
      return c.json({ error: "rate limited" }, 429);
    let body: { email?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const email = (body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return c.json({ error: "invalid email" }, 400);

    await store.getOrCreateAccount(email, now());
    const raw = randomToken();
    const pollId = randomToken(12);
    await store.createLoginToken(await sha256hex(raw), email, pollId, now() + LOGIN_TTL_MS, now());

    const base = (deps.appBaseUrl ?? new URL(c.req.url).origin).replace(/\/$/, "");
    const link = `${base}/auth/verify?token=${raw}`;
    if (sendEmail) {
      try {
        await sendEmail(magicLinkEmail(email, link));
      } catch (e) {
        return c.json({ error: `could not send email: ${(e as Error).message}` }, 502);
      }
    } else if (!exposeMagicLink) {
      // No sender configured and not in dev mode → fail loudly rather than
      // pretend a link went out.
      return c.json({ error: "email delivery not configured" }, 503);
    }
    return c.json({
      ok: true,
      poll_id: pollId,
      interval_ms: POLL_INTERVAL_MS,
      expires_in_ms: LOGIN_TTL_MS,
      // Only present when exposeMagicLink is on (dev/test). Lets a headless flow
      // complete without a real inbox; never set in production.
      ...(exposeMagicLink ? { devLink: link } : {}),
    });
  });

  // The email link lands here in a browser. Consume the token (single-use) and
  // show a plain page telling the user to return to their terminal.
  app.get("/auth/verify", async (c) => {
    const token = c.req.query("token") ?? "";
    const okPage = (msg: string, ok: boolean) =>
      c.html(
        `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
          `<h2>${ok ? "✓ Email confirmed" : "Link expired"}</h2><p>${msg}</p></body>`,
        ok ? 200 : 400,
      );
    if (!token) return okPage("Missing token.", false);
    const consumed = await store.consumeLoginToken(await sha256hex(token), now());
    return consumed
      ? okPage("Return to your terminal — cli-chat is finishing your login.", true)
      : okPage("This link was already used or has expired. Request a new one.", false);
  });

  // The CLI polls here after starting login. Once the link is clicked, mint a
  // long-lived session token and hand it back (one-shot: the login row is then
  // claimed so it can't mint a second session).
  app.post("/auth/poll", async (c) => {
    let body: { poll_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const pollId = (body.poll_id ?? "").trim();
    if (!pollId) return c.json({ error: "missing poll_id" }, 400);
    const poll = await store.pollLogin(pollId, now());
    if (poll.status !== "ready") return c.json({ status: poll.status });

    const account = await store.getOrCreateAccount(poll.email, now());
    const sessionToken = randomToken();
    await store.createSession(await sha256hex(sessionToken), account.id, now() + SESSION_TTL_MS, now());
    await store.claimLogin(pollId);
    return c.json({
      status: "ready",
      session_token: sessionToken,
      account: { email: account.email, paid: account.paid, hasVault: account.signPub != null },
    });
  });

  // Pull the synced account blob. Paid accounts only.
  app.get("/vault", async (c) => {
    const account = await requireSession(c);
    if (!account) return c.json({ error: "unauthorized" }, 401);
    if (!account.paid && !freeSync) return c.json({ error: "payment_required", checkoutUrl: checkoutUrl ?? null }, 402);
    const v = await store.getVault(account.id);
    return c.json({ ok: true, blob: v?.blob ?? null, version: v?.version ?? 0 });
  });

  // Push the synced account blob (last-write-wins on version). On first push the
  // user's signPub is bound to the account so the mailbox identity and the online
  // account are linked. A stale version → 409 with the current row to merge.
  app.put("/vault", async (c) => {
    const account = await requireSession(c);
    if (!account) return c.json({ error: "unauthorized" }, 401);
    if (!account.paid && !freeSync) return c.json({ error: "payment_required", checkoutUrl: checkoutUrl ?? null }, 402);
    const raw = await c.req.text();
    if (raw.length > MAX_VAULT_BYTES) return c.json({ error: "vault too large" }, 413);
    let body: { blob?: string; version?: number; signPub?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.blob !== "string" || typeof body.version !== "number")
      return c.json({ error: "missing blob/version" }, 400);
    if (body.signPub && account.signPub !== body.signPub)
      await store.bindAccountSignPub(account.id, body.signPub, now());
    const res = await store.putVault(account.id, body.blob, body.version, now());
    if (res !== "ok") return c.json({ ok: false, reason: "stale", current: res.stale }, 409);
    // Wake the account's other devices so they pull this new version in real time.
    // signPub keys the shared inbox DO; body.signPub is what we just bound.
    const signPub = body.signPub ?? account.signPub;
    if (signPub) notifyVault?.(signPub);
    return c.json({ ok: true, version: body.version });
  });

  // Hand back the one-time checkout link for this account (client_reference_id =
  // account id, so the webhook can flip `paid`). 409 if already paid.
  app.post("/billing/checkout", async (c) => {
    const account = await requireSession(c);
    if (!account) return c.json({ error: "unauthorized" }, 401);
    if (account.paid) return c.json({ ok: true, paid: true, note: "already unlocked" });
    if (!checkoutUrl) return c.json({ error: "billing not configured" }, 503);
    const sep = checkoutUrl.includes("?") ? "&" : "?";
    const url =
      `${checkoutUrl}${sep}client_reference_id=${encodeURIComponent(account.id)}` +
      `&prefilled_email=${encodeURIComponent(account.email)}`;
    return c.json({ ok: true, paid: false, checkoutUrl: url });
  });

  // Provider webhook (Stripe). Verify the signature, then flip `paid`. Verifier is
  // injected; absent on Node, so the route 503s there rather than trusting input.
  app.post("/billing/webhook", async (c) => {
    if (!verifyPayment) return c.json({ error: "billing not configured" }, 503);
    const raw = await c.req.text();
    const event = await verifyPayment(raw, c.req.header("stripe-signature") ?? null).catch(() => null);
    if (!event) return c.json({ error: "invalid signature" }, 400);
    await store.setAccountPaid(event.accountId, now());
    return c.json({ ok: true });
  });

  return app;
}
