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
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { store, now } = deps;

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/messages", async (c) => {
    const raw = await c.req.text();
    const auth = await verifyRequest(
      (h) => c.req.header(h),
      "POST",
      "/messages",
      raw,
      now(),
    );
    if (!auth.ok) return c.json({ error: auth.reason }, 401);

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

    await store.put({
      id: msg.id,
      recipient: msg.recipient,
      sender: msg.sender,
      body: msg.body,
      tags: msg.tags ?? null,
      created_at: msg.created_at,
      in_reply_to: msg.in_reply_to ?? null,
    });
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

  // Resolve a handle → public keys. Public (these are public keys).
  app.get("/resolve/:handle", async (c) => {
    const rec = await store.resolveHandle(c.req.param("handle"));
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(rec);
  });

  return app;
}
