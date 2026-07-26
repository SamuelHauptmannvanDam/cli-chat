// Background push warmer. Runs inside the long-lived MCP server process, on its
// own event loop — independent of any tool call, so it NEVER occupies the agent's
// turn. Holds a WebSocket to the recipient's inbox Durable Object; on a "wake"
// frame it drains new mail into the local cache (and desktop-notifies — notify.ts).
// The agent surfaces it on the next engagement (the inbox rider) or live (the chat
// waker / read_messages).
//
// Push is an accelerator, not the source of truth:
//   - on (re)connect it does a catch-up `sync` (anything missed while offline),
//   - a slow fallback poll covers any missed wake,
//   - so a dropped socket never loses mail.
//
// See PUSH.md. The server side is server-mailbox/inbox-do.ts + /connect.
//
// Uses Node's native global WebSocket (Node 22+). The WHATWG API can't set
// request headers on the handshake, so the Ed25519 auth (same canonical string
// as the HTTP routes) travels in the URL query instead — the server reads it
// from there. See STORE.md.

import { rmSync } from "node:fs";
import { makeAuthHeaders } from "./auth.ts";
import { sync, refreshPending, type NetContext } from "./core-net.ts";
import { notifyNewMail } from "./notify.ts";

export interface WarmerOpts {
  mailboxUrl: string;
  now: () => number;
  // Where to mirror unread mail for the session hook, and where to read its acks.
  // The warmer is the sole writer of pendingPath; the hook the sole writer of ackPath.
  pendingPath: string;
  ackPath: string;
  // Desktop notifications (notify.ts): the settings file carrying the notify
  // preference, and chat.lock so a live feed suppresses them.
  settingsPath: string;
  chatLockPath: string;
  // Called on a {t:"vault"} wake (another device pushed a new vault version) and
  // on reconnect catch-up — pull + apply the account's vault. Absent → the warmer
  // is mail-only and ignores vault frames. Must not throw; coalesced by the warmer.
  onVault?: () => void | Promise<void>;
  // Called on a {t:"history"} wake (another device appended history chunks) and on
  // reconnect catch-up — pull past the cursor. Same contract as onVault.
  onHistory?: () => void | Promise<void>;
}

const PING_MS = 30_000; // keepalive cadence
const POLL_MS = 60_000; // fallback safety-net drain (vs the old 3s loop)
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// Start the warmer. Returns a stop() that tears everything down.
export function startWarmer(ctx: NetContext, opts: WarmerOpts): () => void {
  const wsUrl = opts.mailboxUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/connect";
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = BACKOFF_START_MS;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let draining = false;
  let syncingVault = false;
  let syncingHistory = false;

  // Pull + apply the account's vault after a {t:"vault"} wake (another device
  // changed contacts/tags) or on reconnect catch-up. Coalesced like drain() so a
  // burst of wakes doesn't stack syncs. Best-effort: the session-start sync and
  // fallback poll are the safety net if a wake is ever missed.
  async function syncVaultWake(): Promise<void> {
    if (syncingVault || stopped || !opts.onVault) return;
    syncingVault = true;
    try {
      await opts.onVault();
    } catch {
      /* network blip — the next wake / fallback poll / session-start sync retries */
    } finally {
      syncingVault = false;
    }
  }

  // Pull history chunks past the device's cursor after a {t:"history"} wake.
  // Same coalescing + best-effort contract as syncVaultWake.
  async function syncHistoryWake(): Promise<void> {
    if (syncingHistory || stopped || !opts.onHistory) return;
    syncingHistory = true;
    try {
      await opts.onHistory();
    } catch {
      /* network blip — the next wake / session-start sync retries */
    } finally {
      syncingHistory = false;
    }
  }

  // Drain new mail into the cache; notify if anything arrived. Coalesces
  // overlapping calls so a burst of wakes doesn't stack network requests.
  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      const added = await sync(ctx);
      // Apply the hook's acks (mark surfaced mail read) and re-mirror the unread
      // set for the hook — every tick, so acks land within a drain even with no
      // new mail. Best-effort: a snapshot write must never break draining.
      try {
        refreshPending(ctx, opts.pendingPath, opts.ackPath);
      } catch {
        /* disk hiccup — the next tick rewrites it */
      }
      if (added > 0)
        notifyNewMail(ctx, { settingsPath: opts.settingsPath, chatLockPath: opts.chatLockPath });
    } catch {
      /* network blip — the next wake or the fallback poll retries */
    } finally {
      draining = false;
    }
  }

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function connect(): void {
    if (stopped) return;
    // Same Ed25519 signed canonical string as the HTTP routes, but carried in the
    // query (native WebSocket can't set headers). Server derives the inbox id
    // from the verified pubkey, so a socket only ever attaches to its own inbox.
    const h = makeAuthHeaders(ctx.me.signPub, ctx.me.signSec, "GET", "/connect", "", opts.now());
    const u = new URL(wsUrl);
    u.searchParams.set("x-pubkey", h["x-pubkey"]);
    u.searchParams.set("x-timestamp", h["x-timestamp"]);
    u.searchParams.set("x-signature", h["x-signature"]);

    ws = new WebSocket(u.toString());

    ws.addEventListener("open", () => {
      backoff = BACKOFF_START_MS; // reset on a healthy connection
      void drain(); // catch up on anything missed while offline
      void syncVaultWake(); // catch up on any vault change missed while offline
      void syncHistoryWake(); // catch up on any history missed while offline
      clearPing();
      pingTimer = setInterval(() => {
        try {
          ws?.send("ping");
        } catch {
          /* will surface as a close/error */
        }
      }, PING_MS);
    });

    ws.addEventListener("message", (ev) => {
      const data = String((ev as MessageEvent).data);
      if (data === "pong") return; // keepalive ack
      // Wake frames are tiny JSON: {t:"mail"|"vault"|"history"}. A vault wake
      // pulls the synced vault, a history wake pulls chunks past the cursor;
      // anything else (mail, or a legacy bare frame) drains mail.
      let t = "mail";
      try {
        t = (JSON.parse(data) as { t?: string }).t ?? "mail";
      } catch {
        /* not JSON — treat as a mail wake */
      }
      if (t === "vault") void syncVaultWake();
      else if (t === "history") void syncHistoryWake();
      else void drain();
    });

    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", () => {
      try {
        ws?.close();
      } catch {
        /* ignore — close handler schedules the reconnect */
      }
    });
  }

  function scheduleReconnect(): void {
    clearPing();
    if (stopped) return;
    const jitter = Math.floor(backoff * 0.3 * Math.random());
    reconnectTimer = setTimeout(connect, backoff + jitter);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  // Seed the hook's snapshot from the local cache immediately, so a hook firing
  // right after boot reads a fresh file instead of falling back to a direct drain.
  // Marked synced:false — it predates the first network drain, so the SessionStart
  // hook knows to wait for the real drain before deciding there's no mail.
  try {
    refreshPending(ctx, opts.pendingPath, opts.ackPath, false);
  } catch {
    /* fine — the first drain will write it */
  }
  connect();
  // Fallback poll: a slow safety net in case a wake is ever missed. 60s vs the
  // old 3s loop — ~20× fewer requests, and only a backstop since push handles
  // the real-time path.
  const pollTimer = setInterval(() => void drain(), POLL_MS);

  return function stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearPing();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    // Drop the snapshot so a later warmer-off session (MESSENGER_PUSH=0) falls back
    // to a direct drain instead of trusting a stale file.
    try {
      rmSync(opts.pendingPath, { force: true });
    } catch {
      /* ignore */
    }
  };
}
