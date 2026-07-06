// Durable Object: one instance per recipient inbox (keyed by their signPub).
// Holds that recipient's live WebSocket connections and pushes a tiny "wake"
// frame when new mail is stored, so clients pull immediately instead of polling.
// Uses the WebSocket Hibernation API, so idle connections cost ~nothing.
//
// Wake-then-pull: the frame carries NO body — just {t:"mail"} for new mail, or
// {t:"vault"} when the account's synced vault changed on another device. On wake
// the client runs the matching authenticated pull (GET /messages, or a vault
// sync), so the server stays the single source of truth and there's nothing to
// dedupe. All of an account's devices share one keypair (hence one signPub, hence
// this one DO), so a vault wake reaches every device of the account. See PUSH.md.
//
// Workers-runtime only: compiled by wrangler at deploy time, NOT by the npm build
// (build.mjs bundles src/ only) or the Node test suite. Types are intentionally
// loose to avoid a @cloudflare/workers-types dependency.

export class Inbox {
  private state: any;

  constructor(state: any, _env: unknown) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal fan-out trigger, called by the Worker after a message is stored
    // (?t=mail, the default) or after a vault push (?t=vault).
    if (url.pathname === "/push") {
      const t = url.searchParams.get("t") || "mail";
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(JSON.stringify({ t }));
        } catch {
          /* dead socket — runtime will clean it up */
        }
      }
      return new Response(null, { status: 204 });
    }

    // Subscriber WebSocket upgrade. Auth (Ed25519 signed headers) is verified by
    // the Worker BEFORE it routes here, and the DO id is derived from the signed
    // pubkey — so a socket can only ever land on its own recipient's inbox.
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new (globalThis as any).WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server); // hibernatable
      return new Response(null, { status: 101, webSocket: client } as any);
    }

    return new Response("not found", { status: 404 });
  }

  // --- Hibernation handlers (invoked by the runtime, even after wake) ---------

  async webSocketMessage(ws: any, message: any): Promise<void> {
    // Lightweight keepalive only; clients may send "ping".
    if (message === "ping") {
      try {
        ws.send("pong");
      } catch {
        /* ignore */
      }
    }
  }

  webSocketClose(ws: any, code: number, _reason: string, _wasClean: boolean): void {
    try {
      ws.close(code);
    } catch {
      /* ignore */
    }
  }

  webSocketError(_ws: any, _err: unknown): void {
    /* runtime cleans up the socket */
  }
}
