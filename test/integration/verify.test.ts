// verify.ts uses platform WebCrypto (Ed25519) — the server half of request
// auth. We sign with the libsodium client (auth.ts) and confirm the WebCrypto
// verifier accepts genuine requests and rejects every tampering we can think of.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { verifyRequest } from "../../server-mailbox/verify.ts";
import { makeAuthHeaders, type AuthHeaders } from "../../src/core/auth.ts";
import { MAX_SKEW_MS } from "../../src/core/canonical.ts";
import { initCrypto, generateIdentity } from "../../src/core/crypto.ts";

before(async () => {
  await initCrypto();
});

const NOW = 1_700_000_000_000;

// Turn signed headers into the (name) => value lookup verifyRequest expects.
function lookup(h: Partial<AuthHeaders>) {
  return (name: string) => (h as Record<string, string>)[name.toLowerCase()];
}

test("verifyRequest accepts a genuine signed request", async () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "POST", "/messages", "{}", NOW);
  const r = await verifyRequest(lookup(h), "POST", "/messages", "{}", NOW);
  assert.ok(r.ok && r.pubkey === id.signPub);
});

test("verifyRequest rejects missing headers", async () => {
  const r = await verifyRequest(lookup({}), "GET", "/mailbox", "", NOW);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.reason, "missing auth headers");
});

test("verifyRequest rejects a non-numeric timestamp", async () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "GET", "/mailbox", "", NOW);
  h["x-timestamp"] = "soon";
  const r = await verifyRequest(lookup(h), "GET", "/mailbox", "", NOW);
  assert.equal(r.ok === false && r.reason, "bad timestamp");
});

test("verifyRequest rejects a stale request beyond the skew window", async () => {
  const id = generateIdentity();
  const stale = NOW - MAX_SKEW_MS - 1;
  const h = makeAuthHeaders(id.signPub, id.signSec, "GET", "/mailbox", "", stale);
  const r = await verifyRequest(lookup(h), "GET", "/mailbox", "", NOW);
  assert.equal(r.ok === false && r.reason, "stale request");
});

test("verifyRequest rejects a body that doesn't match the signature", async () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "POST", "/messages", "original", NOW);
  const r = await verifyRequest(lookup(h), "POST", "/messages", "tampered", NOW);
  assert.equal(r.ok === false && r.reason, "bad signature");
});

test("verifyRequest rejects when the path is changed after signing", async () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "GET", "/messages", "", NOW);
  const r = await verifyRequest(lookup(h), "GET", "/mailbox", "", NOW);
  assert.equal(r.ok === false && r.reason, "bad signature");
});

test("verifyRequest rejects malformed key/signature encoding", async () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "GET", "/mailbox", "", NOW);
  h["x-signature"] = "zz"; // not valid hex/sig
  const r = await verifyRequest(lookup(h), "GET", "/mailbox", "", NOW);
  assert.equal(r.ok, false);
});

test("verifyRequest catches a structurally invalid (odd-length hex) pubkey", async () => {
  const id = generateIdentity();
  const h = makeAuthHeaders(id.signPub, id.signSec, "GET", "/mailbox", "", NOW);
  h["x-pubkey"] = "abc"; // odd-length hex → fromHex throws inside the verify try/catch
  const r = await verifyRequest(lookup(h), "GET", "/mailbox", "", NOW);
  assert.equal(r.ok === false && r.reason, "bad key or signature encoding");
});
