// Phase 1 crypto: libsodium sealed boxes for E2E body encryption + Ed25519
// detached signatures for request auth. We never roll our own crypto.
//
// Each identity carries two keypairs:
//   - box  (X25519): recipients are sealed to this; only the holder opens.
//   - sign (Ed25519): used as the user's address AND to sign API requests.

// libsodium is loaded lazily inside initCrypto rather than imported at module
// top level. Importing it eagerly kicks off WASM init + RNG seeding in *global
// scope*, which the Cloudflare Workers runtime forbids ("Disallowed operation
// called within global scope"). Deferring the import to the first handler call
// keeps that work inside request scope, where it's allowed. (Node is lax about
// this either way.)
let s: any = null;
export async function initCrypto(): Promise<void> {
  if (s) return;
  const mod = await import("libsodium-wrappers");
  const sodium = mod.default ?? mod;
  await sodium.ready;
  s = sodium;
}

const B64 = () => s.base64_variants.ORIGINAL;

export interface Identity {
  boxPub: string;
  boxSec: string;
  signPub: string; // doubles as the user's address / mailbox key
  signSec: string;
  handle?: string; // short 6-char directory handle, assigned at registration
  name?: string; // human display label — local only, never sent to the server
}

// Public half of an identity — what lives in a contact book.
export interface PublicKeys {
  signPub: string;
  boxPub: string;
}

export function generateIdentity(): Identity {
  const box = s.crypto_box_keypair();
  const sign = s.crypto_sign_keypair();
  return {
    boxPub: s.to_hex(box.publicKey),
    boxSec: s.to_hex(box.privateKey),
    signPub: s.to_hex(sign.publicKey),
    signSec: s.to_hex(sign.privateKey),
  };
}

// Seal plaintext to a recipient's box public key. Anonymous: the recipient
// can't tell who sent it from the box layer (we carry sender in the signed
// envelope instead). Returns base64.
export function seal(plaintext: string, recipientBoxPubHex: string): string {
  const ct = s.crypto_box_seal(
    s.from_string(plaintext),
    s.from_hex(recipientBoxPubHex),
  );
  return s.to_base64(ct, B64());
}

export function open(
  cipherB64: string,
  boxPubHex: string,
  boxSecHex: string,
): string {
  const pt = s.crypto_box_seal_open(
    s.from_base64(cipherB64, B64()),
    s.from_hex(boxPubHex),
    s.from_hex(boxSecHex),
  );
  return s.to_string(pt);
}

export function signDetached(message: string, signSecHex: string): string {
  const sig = s.crypto_sign_detached(s.from_string(message), s.from_hex(signSecHex));
  return s.to_hex(sig);
}

export function verifyDetached(
  sigHex: string,
  message: string,
  signPubHex: string,
): boolean {
  try {
    return s.crypto_sign_verify_detached(
      s.from_hex(sigHex),
      s.from_string(message),
      s.from_hex(signPubHex),
    );
  } catch {
    return false;
  }
}
