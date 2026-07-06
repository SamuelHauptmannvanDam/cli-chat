// Opaque-token helpers for the account layer (magic-link + sessions). Uses the
// WebCrypto global (`crypto`), which exists on both Node 22+ and Cloudflare
// Workers, so this file — like canonical.ts — runs unchanged on either runtime
// with no dependency of its own.
//
// Tokens are random and only ever STORED as a SHA-256 hash: the raw value lives
// in the emailed link / on the user's device, the server keeps the hash, and a
// lookup re-hashes the presented token and compares. A DB leak therefore can't
// reveal anyone's session or login token.

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// A fresh URL-safe random token (default 32 bytes → 64 hex chars of entropy).
export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// Short opaque id (not a secret) for the poll handle and account/row ids.
export function randomId(bytes = 16): string {
  return randomToken(bytes);
}

// SHA-256 of a token, hex — the form stored in login_tokens / sessions.
export async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return hex(digest);
}
