// Parking for a magic-link login that authenticated but still needs the user's
// display name (brand-new email, no identity on this device).
//
// WHY IT'S ON DISK. The server-side poll token is one-shot — `/auth/poll` calls
// claimLogin(), so re-polling the same poll_id returns `expired`. The session it
// minted is therefore the ONLY way to finish that login. This used to be parked
// in a Map, which lost it whenever the MCP server process restarted between
// "what's your name?" and the user answering — and a 60s blocking poll makes a
// client tool-timeout (and the restart after it) routine. Worse, the account row
// already exists by then with no identity, so retrying lands on `need_name`
// again: the email became permanently un-onboardable. One real signup was lost
// to exactly this before it was found.
//
// Kept out of server-net.ts so it's unit-testable without the MCP plumbing
// (same reason as vault-sync.ts).

import { readFileSync, rmSync } from "node:fs";
import { secureDir, writeSecret } from "./secure-fs.ts";
import { dataHome, pendingLoginFile } from "./paths.ts";

export interface ParkedLogin<A = unknown> {
  poll_id: string;
  token: string; // bearer session token — a secret
  account: A;
  at: number;
}

// Generous enough that a human can be asked their name, wander off and come
// back; short enough that a bearer token doesn't sit on disk forever after an
// abandoned setup. The session itself lives far longer — this bounds only the
// unattended parking.
export const PARKED_LOGIN_TTL_MS = 24 * 60 * 60 * 1000;

// Park the minted session against its poll_id. Best-effort: a failure here just
// restores the old behaviour of having to restart the login, never breaks it.
export function parkLogin<A>(poll_id: string, token: string, account: A, now: number): void {
  try {
    secureDir(dataHome());
    writeSecret(pendingLoginFile(), JSON.stringify({ poll_id, token, account, at: now } satisfies ParkedLogin<A>));
  } catch {
    /* falls back to restarting the login */
  }
}

// Read back the parked login for `poll_id`. Returns null unless the poll_id
// matches exactly and it's inside the TTL — so a stale park from an abandoned
// attempt can never be adopted by a later, unrelated login.
export function readParkedLogin<A>(poll_id: string, now: number): ParkedLogin<A> | null {
  try {
    const p = JSON.parse(readFileSync(pendingLoginFile(), "utf8")) as ParkedLogin<A>;
    if (!p || p.poll_id !== poll_id || !p.token) return null;
    if (typeof p.at !== "number" || now - p.at > PARKED_LOGIN_TTL_MS) return null;
    return p;
  } catch {
    return null; // absent, unreadable, or not ours
  }
}

export function clearParkedLogin(): void {
  try {
    rmSync(pendingLoginFile(), { force: true });
  } catch {
    /* a leftover is harmless: it expires, and only its own poll_id can use it */
  }
}
