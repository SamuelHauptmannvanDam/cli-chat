// Client-side sealing of the synced account blobs (vault + history chunks).
// AES-256-GCM under the account's data key — a per-account symmetric key the
// server mints on first login and hands over on the authenticated channel. The
// server stores only ciphertext (plus the key, so this is encryption AT REST
// against leaks/dumps, not E2E against the operator — AUTH-SYNC.md §4).
//
// Wire format: "enc1:" + base64(iv) + ":" + base64(ciphertext‖tag). Anything
// without the prefix is treated as a legacy plaintext blob so pre-encryption
// vaults keep applying after the upgrade.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc1:";
const IV_BYTES = 12;

function keyBuf(dataKeyHex: string): Buffer {
  const key = Buffer.from(dataKeyHex, "hex");
  if (key.length !== 32) throw new Error("data key must be 32 bytes of hex");
  return key;
}

export function isEncryptedBlob(blob: string): boolean {
  return blob.startsWith(PREFIX);
}

export function encryptBlob(plain: string, dataKeyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBuf(dataKeyHex), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return PREFIX + iv.toString("base64") + ":" + ct.toString("base64");
}

// Decrypt an "enc1:" blob; a legacy plaintext blob passes through unchanged so
// callers can treat every stored blob uniformly.
export function decryptBlob(blob: string, dataKeyHex: string | undefined): string {
  if (!isEncryptedBlob(blob)) return blob;
  if (!dataKeyHex) throw new Error("blob is encrypted but no data key is available");
  const [ivB64, ctB64] = blob.slice(PREFIX.length).split(":");
  if (!ivB64 || !ctB64) throw new Error("malformed encrypted blob");
  const buf = Buffer.from(ctB64, "base64");
  if (buf.length < 17) throw new Error("malformed encrypted blob");
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", keyBuf(dataKeyHex), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
