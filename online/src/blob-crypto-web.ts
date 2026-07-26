// WebCrypto port of src/blob-crypto.ts for the browser client. Same wire format
// ("enc1:" + base64(iv) + ":" + base64(ciphertext‖tag), AES-256-GCM under the
// account data key) so vaults and history chunks interop with every other
// device. Async because crypto.subtle is; otherwise a faithful mirror.

const PREFIX = "enc1:";
const IV_BYTES = 12;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(dataKeyHex: string): Promise<CryptoKey> {
  const key = hexToBytes(dataKeyHex);
  if (key.length !== 32) throw new Error("data key must be 32 bytes of hex");
  return crypto.subtle.importKey("raw", key.buffer as ArrayBuffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export function isEncryptedBlob(blob: string): boolean {
  return blob.startsWith(PREFIX);
}

export async function encryptBlob(plain: string, dataKeyHex: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(dataKeyHex);
  // WebCrypto appends the 16-byte tag to the ciphertext — exactly the layout
  // blob-crypto.ts writes by concatenating cipher output + getAuthTag().
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)),
  );
  return PREFIX + b64encode(iv) + ":" + b64encode(ct);
}

// Decrypt an "enc1:" blob; legacy plaintext blobs pass through unchanged.
export async function decryptBlob(blob: string, dataKeyHex: string | undefined): Promise<string> {
  if (!isEncryptedBlob(blob)) return blob;
  if (!dataKeyHex) throw new Error("blob is encrypted but no data key is available");
  const [ivB64, ctB64] = blob.slice(PREFIX.length).split(":");
  if (!ivB64 || !ctB64) throw new Error("malformed encrypted blob");
  const iv = b64decode(ivB64);
  const ct = b64decode(ctB64);
  if (ct.length < 17) throw new Error("malformed encrypted blob");
  const key = await importKey(dataKeyHex);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct.buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(pt);
}
