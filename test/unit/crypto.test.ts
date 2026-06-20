import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  initCrypto,
  generateIdentity,
  seal,
  open,
  signDetached,
  verifyDetached,
} from "../../src/crypto.ts";

before(async () => {
  await initCrypto();
});

test("generateIdentity yields two hex keypairs", () => {
  const id = generateIdentity();
  for (const k of ["boxPub", "boxSec", "signPub", "signSec"] as const) {
    assert.match(id[k]!, /^[0-9a-f]+$/, `${k} is hex`);
  }
  // Ed25519/X25519 public keys are 32 bytes = 64 hex chars.
  assert.equal(id.signPub.length, 64);
  assert.equal(id.boxPub.length, 64);
});

test("generateIdentity is unique per call", () => {
  assert.notEqual(generateIdentity().signPub, generateIdentity().signPub);
});

test("seal then open round-trips the plaintext", () => {
  const bob = generateIdentity();
  const ct = seal("the eagle lands at noon", bob.boxPub);
  assert.notEqual(ct, "the eagle lands at noon");
  assert.equal(open(ct, bob.boxPub, bob.boxSec), "the eagle lands at noon");
});

test("seal output is base64 and hides the plaintext", () => {
  const bob = generateIdentity();
  const ct = seal("plaintext-secret", bob.boxPub);
  assert.match(ct, /^[A-Za-z0-9+/]+=*$/);
  assert.ok(!ct.includes("plaintext-secret"));
});

test("a sealed box cannot be opened by the wrong identity", () => {
  const bob = generateIdentity();
  const mallory = generateIdentity();
  const ct = seal("for bob only", bob.boxPub);
  assert.throws(() => open(ct, mallory.boxPub, mallory.boxSec));
});

test("seal is non-deterministic (ephemeral sender key per seal)", () => {
  const bob = generateIdentity();
  assert.notEqual(seal("same", bob.boxPub), seal("same", bob.boxPub));
});

test("signDetached produces a signature verifyDetached accepts", () => {
  const id = generateIdentity();
  const sig = signDetached("canonical-bytes", id.signSec);
  assert.ok(verifyDetached(sig, "canonical-bytes", id.signPub));
});

test("verifyDetached rejects a tampered message", () => {
  const id = generateIdentity();
  const sig = signDetached("original", id.signSec);
  assert.equal(verifyDetached(sig, "tampered", id.signPub), false);
});

test("verifyDetached rejects a signature from another key", () => {
  const a = generateIdentity();
  const b = generateIdentity();
  const sig = signDetached("msg", a.signSec);
  assert.equal(verifyDetached(sig, "msg", b.signPub), false);
});

test("verifyDetached returns false (not throws) on garbage input", () => {
  const id = generateIdentity();
  assert.equal(verifyDetached("not-hex!!", "msg", id.signPub), false);
});
