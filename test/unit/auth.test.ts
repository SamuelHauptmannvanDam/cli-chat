import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeAuthHeaders } from "../../src/auth.ts";
import { canonical } from "../../src/canonical.ts";
import { initCrypto, generateIdentity, verifyDetached } from "../../src/crypto.ts";

before(async () => {
  await initCrypto();
});

test("makeAuthHeaders carries pubkey and timestamp verbatim", () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "POST", "/messages", "{}", 1700);
  assert.equal(h["x-pubkey"], id.signPub);
  assert.equal(h["x-timestamp"], "1700");
  assert.match(h["x-signature"], /^[0-9a-f]+$/);
});

test("the signature verifies against the canonical bytes", () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "post", "/messages", "body", 42);
  // method is upper-cased inside canonical(); the verifier must agree.
  const expected = canonical("POST", "/messages", 42, "body");
  assert.ok(verifyDetached(h["x-signature"], expected, id.signPub));
});

test("the signature is bound to method, path, timestamp, and body", () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "GET", "/mailbox", "", 10);
  assert.equal(verifyDetached(h["x-signature"], canonical("GET", "/mailbox", 11, ""), id.signPub), false);
  assert.equal(verifyDetached(h["x-signature"], canonical("GET", "/other", 10, ""), id.signPub), false);
  assert.equal(verifyDetached(h["x-signature"], canonical("POST", "/mailbox", 10, ""), id.signPub), false);
});
