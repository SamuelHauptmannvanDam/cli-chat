// Server-side signed-request verification using the platform WebCrypto API
// (globalThis.crypto.subtle). Ed25519 is supported natively on both Cloudflare
// Workers and Node 20+, so this runs everywhere the mailbox runs — no
// libsodium / WASM, which Workers can't instantiate at runtime.

import { canonical, MAX_SKEW_MS } from "../src/canonical.ts";

// Return the non-shared-backed view (Uint8Array<ArrayBuffer>) so it satisfies
// WebCrypto's BufferSource — the bare `Uint8Array` alias widens to ArrayBufferLike.
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export type VerifyResult =
  | { ok: true; pubkey: string }
  | { ok: false; reason: string };

export async function verifyRequest(
  header: (name: string) => string | undefined | null,
  method: string,
  path: string,
  body: string,
  now: number,
): Promise<VerifyResult> {
  const pubkey = header("x-pubkey");
  const ts = header("x-timestamp");
  const sig = header("x-signature");
  if (!pubkey || !ts || !sig) return { ok: false, reason: "missing auth headers" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(now - tsNum) > MAX_SKEW_MS) return { ok: false, reason: "stale request" };

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(pubkey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromHex(sig),
      new TextEncoder().encode(canonical(method, path, tsNum, body)),
    );
    if (!valid) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "bad key or signature encoding" };
  }

  return { ok: true, pubkey };
}
