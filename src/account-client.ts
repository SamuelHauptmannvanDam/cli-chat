// Client for the online-account layer (AUTH-SYNC.md): magic-link login + vault
// sync against the hosted mailbox. Unlike mailbox-client.ts (which signs every
// request with the user's Ed25519 key), these routes authenticate with a Bearer
// session token — because login happens on a fresh device that doesn't have the
// keypair yet (it's *inside* the vault it's about to pull).

export interface LoginStart {
  poll_id: string;
  interval_ms: number;
  expires_in_ms: number;
  devLink?: string; // only when the server runs with exposeMagicLink (dev/test)
}

export type PollResult =
  | { status: "pending" }
  | { status: "expired" }
  | {
      status: "ready";
      session_token: string;
      account: { email: string; paid: boolean; hasVault: boolean };
    };

export interface VaultPull {
  blob: string | null;
  version: number;
}

export type VaultPush =
  | { ok: true; version: number }
  | { ok: false; reason: "stale"; current: { blob: string; version: number } }
  | { ok: false; reason: "payment_required"; checkoutUrl: string | null };

export interface AccountClient {
  startLogin(email: string): Promise<LoginStart>;
  poll(pollId: string): Promise<PollResult>;
  pullVault(token: string): Promise<VaultPull | "unauthorized" | "payment_required">;
  pushVault(token: string, blob: string, version: number, signPub: string): Promise<VaultPush>;
  checkout(token: string): Promise<{ paid: boolean; checkoutUrl?: string } | "unauthorized">;
}

export function createAccountClient(baseUrl: string): AccountClient {
  const base = baseUrl.replace(/\/$/, "");
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

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
    async startLogin(email) {
      const res = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) await fail(res, "login");
      return (await res.json()) as LoginStart;
    },

    async poll(pollId) {
      const res = await fetch(`${base}/auth/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poll_id: pollId }),
      });
      if (!res.ok) await fail(res, "poll");
      return (await res.json()) as PollResult;
    },

    async pullVault(token) {
      const res = await fetch(`${base}/vault`, { headers: bearer(token) });
      if (res.status === 401) return "unauthorized";
      if (res.status === 402) return "payment_required";
      if (!res.ok) await fail(res, "vault pull");
      const j = (await res.json()) as { blob: string | null; version: number };
      return { blob: j.blob, version: j.version };
    },

    async pushVault(token, blob, version, signPub) {
      const res = await fetch(`${base}/vault`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ blob, version, signPub }),
      });
      if (res.status === 402) {
        const j = (await res.json().catch(() => ({}))) as { checkoutUrl?: string | null };
        return { ok: false, reason: "payment_required", checkoutUrl: j.checkoutUrl ?? null };
      }
      if (res.status === 409) {
        const j = (await res.json()) as { current: { blob: string; version: number } };
        return { ok: false, reason: "stale", current: j.current };
      }
      if (!res.ok) await fail(res, "vault push");
      return (await res.json()) as { ok: true; version: number };
    },

    async checkout(token) {
      const res = await fetch(`${base}/billing/checkout`, { method: "POST", headers: bearer(token) });
      if (res.status === 401) return "unauthorized";
      if (!res.ok) await fail(res, "checkout");
      return (await res.json()) as { paid: boolean; checkoutUrl?: string };
    },
  };
}
