// Client for the hosted mailbox. Signs every request with the user's Ed25519
// key. Knows nothing about plaintext — it ships and retrieves sealed blobs.

import { makeAuthHeaders } from "./auth.ts";
import type { Identity } from "./crypto.ts";
import type { WireMessage } from "./identity.ts";

export interface MailboxClient {
  send(msg: WireMessage): Promise<void>;
  summary(): Promise<{ count: number; messages: any[] }>;
  drain(): Promise<WireMessage[]>;
  registerHandle(handle: string): Promise<"ok" | "taken">;
  resolveHandle(handle: string): Promise<{ signPub: string; boxPub: string } | null>;
}

export function createMailboxClient(
  baseUrl: string,
  identity: Identity,
  now: () => number,
): MailboxClient {
  const base = baseUrl.replace(/\/$/, "");

  function headers(method: string, path: string, body: string) {
    return makeAuthHeaders(
      identity.signPub,
      identity.signSec,
      method,
      path,
      body,
      now(),
    ) as unknown as Record<string, string>;
  }

  async function fail(res: Response, what: string): Promise<never> {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${what} failed: ${res.status} ${detail}`);
  }

  return {
    async send(msg) {
      const body = JSON.stringify(msg);
      const res = await fetch(`${base}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/messages", body) },
        body,
      });
      if (!res.ok) await fail(res, "send");
    },

    async summary() {
      const res = await fetch(`${base}/mailbox`, {
        headers: headers("GET", "/mailbox", ""),
      });
      if (!res.ok) await fail(res, "summary");
      return (await res.json()) as { count: number; messages: any[] };
    },

    async drain() {
      const res = await fetch(`${base}/messages`, {
        headers: headers("GET", "/messages", ""),
      });
      if (!res.ok) await fail(res, "drain");
      const data = (await res.json()) as { messages: WireMessage[] };
      return data.messages;
    },

    async registerHandle(handle) {
      const body = JSON.stringify({ handle, signPub: identity.signPub, boxPub: identity.boxPub });
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/register", body) },
        body,
      });
      if (res.status === 409) return "taken";
      if (!res.ok) await fail(res, "register");
      return "ok";
    },

    async resolveHandle(handle) {
      // Sign the resolve like every other route — the server requires it so the
      // handle directory can't be walked anonymously. The path (handle included)
      // is what gets signed, so it must match the URL exactly.
      const path = `/resolve/${encodeURIComponent(handle)}`;
      const res = await fetch(`${base}${path}`, { headers: headers("GET", path, "") });
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "resolve");
      return (await res.json()) as { signPub: string; boxPub: string };
    },
  };
}
