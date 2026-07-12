// Unit tests for the client-side blob sealing (blob-crypto.ts): the AES-256-GCM
// layer the vault + history sync wrap around every blob before it leaves the
// device. Legacy plaintext blobs must keep flowing through unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptBlob, decryptBlob, isEncryptedBlob } from "../../src/blob-crypto.ts";

const KEY = randomBytes(32).toString("hex");

test("encrypt then decrypt round-trips, and the wire form is opaque", () => {
  const plain = JSON.stringify({ v: 1, contacts: ["Niels"], note: "æøå ünïcode 🙂" });
  const sealed = encryptBlob(plain, KEY);
  assert.ok(isEncryptedBlob(sealed));
  assert.ok(!sealed.includes("Niels"), "ciphertext must not leak plaintext");
  assert.equal(decryptBlob(sealed, KEY), plain);
});

test("every encryption uses a fresh IV (same plaintext, different ciphertext)", () => {
  assert.notEqual(encryptBlob("same", KEY), encryptBlob("same", KEY));
});

test("the wrong key fails closed, never returns garbage", () => {
  const sealed = encryptBlob("secret", KEY);
  assert.throws(() => decryptBlob(sealed, randomBytes(32).toString("hex")));
});

test("a tampered blob fails the GCM tag", () => {
  const sealed = encryptBlob("secret", KEY);
  // Flip a character in the ciphertext half.
  const flip = (c: string) => (c === "A" ? "B" : "A");
  const tampered = sealed.slice(0, -2) + flip(sealed.slice(-2, -1)) + sealed.slice(-1);
  assert.throws(() => decryptBlob(tampered, KEY));
});

test("legacy plaintext blobs pass through decryptBlob unchanged", () => {
  const legacy = JSON.stringify({ v: 1, identity: { handle: "AbC123" } });
  assert.equal(isEncryptedBlob(legacy), false);
  assert.equal(decryptBlob(legacy, KEY), legacy);
  assert.equal(decryptBlob(legacy, undefined), legacy, "no key needed for plaintext");
});

test("an encrypted blob without a key on hand is an error, not silence", () => {
  const sealed = encryptBlob("secret", KEY);
  assert.throws(() => decryptBlob(sealed, undefined), /no data key/);
});

test("a short/garbled key is rejected", () => {
  assert.throws(() => encryptBlob("x", "abcd"), /32 bytes/);
});
