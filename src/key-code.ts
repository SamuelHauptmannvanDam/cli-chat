// A shareable "key code" that bundles both public keys — the thing you hand
// someone like a phone number. To message a person you need their signPub
// (mailbox address) AND their boxPub (to seal to), so the code carries both
// (64 bytes total), encoded as Base62 — letters and digits only, nothing to
// escape in shells/URLs/copy-paste. No prefix. ~86 characters.

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"; // 62, '0' == 0
const KEY_BYTES = 64; // signPub(32) + boxPub(32)
const WIDTH = 86; // fixed Base62 length for 64 bytes (max is 86)

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesToBase62(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(WIDTH, ALPHABET[0]);
}

function base62ToBytes(str: string, len: number): Uint8Array | null {
  let n = 0n;
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 62n + BigInt(v);
  }
  const bytes = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return n === 0n ? bytes : null; // value didn't fit → not a valid code
}

export function encodeKey(signPubHex: string, boxPubHex: string): string {
  const blob = new Uint8Array(KEY_BYTES);
  blob.set(hexToBytes(signPubHex), 0);
  blob.set(hexToBytes(boxPubHex), 32);
  return bytesToBase62(blob);
}

// Short phone-number-style handle: 6 Base62 chars, resolved via the server
// registry. The thing people actually share for an MVP.
export const HANDLE_LEN = 6;

export function isHandle(s: string): boolean {
  return new RegExp(`^[0-9A-Za-z]{${HANDLE_LEN}}$`).test(s.trim());
}

// Random handle using crypto-grade bytes (rejection-free: map each byte mod 62).
export function randomHandle(randomBytes: Uint8Array): string {
  let h = "";
  for (let i = 0; i < HANDLE_LEN; i++) h += ALPHABET[randomBytes[i] % 62];
  return h;
}

export function parseKey(raw: string): { signPub: string; boxPub: string } | null {
  const s = raw.trim();
  if (s.length !== WIDTH) return null;
  const bytes = base62ToBytes(s, KEY_BYTES);
  if (!bytes) return null;
  return {
    signPub: bytesToHex(bytes.slice(0, 32)),
    boxPub: bytesToHex(bytes.slice(32, 64)),
  };
}
