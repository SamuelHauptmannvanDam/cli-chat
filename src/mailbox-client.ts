// Client for the hosted mailbox. Signs every request with the user's Ed25519
// key. Knows nothing about plaintext — it ships and retrieves sealed blobs.

import { makeAuthHeaders } from "./auth.ts";
import type { Identity } from "./crypto.ts";
import type { WireMessage } from "./identity.ts";

// One person in your second-degree network (CONTACTS-OF-CONTACTS.md, FRIENDS.md).
// NAME-ONLY: `signPub` is an opaque routing id for addressing a connect request —
// there's no boxPub/handle, so you can't message them directly (that's the point).
// `via` are the signPubs of YOUR contacts who link to them (mapped to nicknames).
export interface NetworkPerson {
  signPub: string;
  name: string | null;
  mutuals: number;
  via: string[];
}

// One incoming connect request (FRIENDS.md). Carries the requester's public keys
// (so you can seal an accept back) + which mutual it came `via`.
export interface FriendRequest {
  fromSignPub: string;
  fromBoxPub: string;
  fromName: string | null;
  viaSignPub: string | null;
  createdAt: number;
}

// A confirmed contact handed back on accept / drained from your accept-inbox: the
// person's public identity, including the boxPub you need to finally message them.
export interface AcceptedContact {
  signPub: string;
  boxPub: string;
  name: string | null;
}

export type RequestOutcome = "ok" | "self" | "exists" | "already_friends" | "unregistered";

export interface MailboxClient {
  send(msg: WireMessage): Promise<void>;
  summary(): Promise<{ count: number; messages: any[] }>;
  drain(): Promise<WireMessage[]>;
  registerHandle(handle: string, name?: string): Promise<"ok" | "taken">;
  resolveHandle(handle: string): Promise<{ signPub: string; boxPub: string } | null>;
  // EMAIL-SEND.md: resolve an email address → keys, provisioning server-side on
  // demand (every address resolves — no membership signal). Null ONLY when the
  // owner closed out-of-band reach (requests-only), mirroring resolveHandle.
  resolveEmail(email: string): Promise<{ signPub: string; boxPub: string } | null>;
  // Contacts of contacts: push the edges you save, drop them on delete, and pull
  // your own second-degree network. Signed like every mailbox route.
  pushEdges(contacts: string[]): Promise<void>;
  removeEdge(contact: string): Promise<void>;
  getNetwork(): Promise<NetworkPerson[]>;
  // Quiet opt-out: never appear in anyone's contacts-of-contacts. Never surfaced.
  hideFromNetwork(): Promise<void>;
  // Friend requests (FRIENDS.md): request a second-degree person by signPub, list
  // your incoming requests, accept/decline, and drain the accepts owed to you.
  requestContact(to: string, via?: string | null): Promise<RequestOutcome>;
  getRequests(): Promise<FriendRequest[]>;
  acceptRequest(from: string): Promise<AcceptedContact | null>;
  declineRequest(from: string): Promise<void>;
  takeAccepts(): Promise<AcceptedContact[]>;
  // Handle controls (FRIENDS.md): requests-only mode + handle rotation.
  setRequestsOnly(on: boolean): Promise<void>;
  rotateHandle(handle: string): Promise<"ok" | "taken" | "no_identity">;
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

    async registerHandle(handle, name) {
      const body = JSON.stringify({
        handle,
        signPub: identity.signPub,
        boxPub: identity.boxPub,
        ...(name ? { name } : {}),
      });
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

    async resolveEmail(email) {
      const body = JSON.stringify({ email });
      const res = await fetch(`${base}/email/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/email/resolve", body) },
        body,
      });
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "email resolve");
      return (await res.json()) as { signPub: string; boxPub: string };
    },

    async pushEdges(contacts) {
      if (!contacts.length) return;
      const body = JSON.stringify({ contacts });
      const res = await fetch(`${base}/edges`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/edges", body) },
        body,
      });
      if (!res.ok) await fail(res, "push edges");
    },

    async removeEdge(contact) {
      const body = JSON.stringify({ contact });
      const res = await fetch(`${base}/edges`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...headers("DELETE", "/edges", body) },
        body,
      });
      if (!res.ok) await fail(res, "remove edge");
    },

    async getNetwork() {
      const res = await fetch(`${base}/network`, { headers: headers("GET", "/network", "") });
      if (!res.ok) await fail(res, "network");
      const data = (await res.json()) as { people: NetworkPerson[] };
      return data.people ?? [];
    },

    async hideFromNetwork() {
      const res = await fetch(`${base}/edges/hidden`, {
        method: "POST",
        headers: headers("POST", "/edges/hidden", ""),
      });
      if (!res.ok) await fail(res, "hide");
    },

    async requestContact(to, via) {
      const body = JSON.stringify({ to, ...(via ? { via } : {}) });
      const res = await fetch(`${base}/requests`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/requests", body) },
        body,
      });
      // 409/400 carry a `reason` the caller turns into a one-liner; 401/5xx throw.
      if (res.status === 409 || res.status === 400) {
        const data = (await res.json().catch(() => ({}))) as { reason?: RequestOutcome };
        if (data.reason) return data.reason;
      }
      if (!res.ok) await fail(res, "request");
      return "ok";
    },

    async getRequests() {
      const res = await fetch(`${base}/requests`, { headers: headers("GET", "/requests", "") });
      if (!res.ok) await fail(res, "requests");
      const data = (await res.json()) as { requests: FriendRequest[] };
      return data.requests ?? [];
    },

    async acceptRequest(from) {
      const body = JSON.stringify({ from });
      const res = await fetch(`${base}/requests/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/requests/accept", body) },
        body,
      });
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "accept");
      const data = (await res.json()) as { contact: AcceptedContact };
      return data.contact ?? null;
    },

    async declineRequest(from) {
      const body = JSON.stringify({ from });
      const res = await fetch(`${base}/requests/decline`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/requests/decline", body) },
        body,
      });
      if (!res.ok) await fail(res, "decline");
    },

    async takeAccepts() {
      const res = await fetch(`${base}/requests/accepted`, {
        headers: headers("GET", "/requests/accepted", ""),
      });
      if (!res.ok) await fail(res, "accepts");
      const data = (await res.json()) as { accepted: AcceptedContact[] };
      return data.accepted ?? [];
    },

    async setRequestsOnly(on) {
      const body = JSON.stringify({ on });
      const res = await fetch(`${base}/handle/requests-only`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/handle/requests-only", body) },
        body,
      });
      if (!res.ok) await fail(res, "requests-only");
    },

    async rotateHandle(handle) {
      const body = JSON.stringify({ handle });
      const res = await fetch(`${base}/handle/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers("POST", "/handle/rotate", body) },
        body,
      });
      if (res.status === 409) return "taken";
      if (res.status === 404) return "no_identity";
      if (!res.ok) await fail(res, "rotate");
      return "ok";
    },
  };
}
