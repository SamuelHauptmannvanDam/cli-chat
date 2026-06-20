// Client-side request signing. The client (always Node) signs the canonical
// string with its Ed25519 key via libsodium and sends pubkey + timestamp +
// signature as headers. The server verifies with WebCrypto — see
// server-mailbox/verify.ts. The canonical bytes live in canonical.ts so both
// sides agree without sharing a crypto dependency.

import { canonical } from "./canonical.ts";
import { signDetached } from "./crypto.ts";

export interface AuthHeaders {
  "x-pubkey": string;
  "x-timestamp": string;
  "x-signature": string;
}

export function makeAuthHeaders(
  signPubHex: string,
  signSecHex: string,
  method: string,
  path: string,
  body: string,
  now: number,
): AuthHeaders {
  const sig = signDetached(canonical(method, path, now, body), signSecHex);
  return {
    "x-pubkey": signPubHex,
    "x-timestamp": String(now),
    "x-signature": sig,
  };
}
