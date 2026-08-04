import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  encodeKey,
  parseKey,
  isHandle,
  randomHandle,
  HANDLE_LEN,
} from "../../src/core/key-code.ts";
import { initCrypto, generateIdentity } from "../../src/core/crypto.ts";

before(async () => {
  await initCrypto();
});

test("encodeKey → parseKey round-trips both public keys", () => {
  const id = generateIdentity();
  const code = encodeKey(id.signPub, id.boxPub);
  const parsed = parseKey(code);
  assert.ok(parsed);
  assert.equal(parsed!.signPub, id.signPub);
  assert.equal(parsed!.boxPub, id.boxPub);
});

test("encoded key is fixed-width Base62 (86 chars, no symbols)", () => {
  const id = generateIdentity();
  const code = encodeKey(id.signPub, id.boxPub);
  assert.equal(code.length, 86);
  assert.match(code, /^[0-9A-Za-z]+$/);
});

test("parseKey tolerates surrounding whitespace", () => {
  const id = generateIdentity();
  const code = encodeKey(id.signPub, id.boxPub);
  assert.deepEqual(parseKey(`  ${code}\n`), parseKey(code));
});

test("parseKey rejects wrong-length input", () => {
  assert.equal(parseKey("tooshort"), null);
  assert.equal(parseKey("x".repeat(85)), null);
  assert.equal(parseKey("x".repeat(87)), null);
});

test("parseKey rejects non-Base62 characters", () => {
  assert.equal(parseKey("+".repeat(86)), null);
});

test("isHandle accepts exactly 6 alphanumerics", () => {
  assert.ok(isHandle("dC0v6m"));
  assert.ok(isHandle("  ABC123 ")); // trimmed
  assert.equal(HANDLE_LEN, 6);
});

test("isHandle rejects wrong length or illegal chars", () => {
  assert.equal(isHandle("abc12"), false);
  assert.equal(isHandle("abc1234"), false);
  assert.equal(isHandle("abc-12"), false);
  assert.equal(isHandle(""), false);
});

test("a full 86-char key is not mistaken for a handle", () => {
  const id = generateIdentity();
  assert.equal(isHandle(encodeKey(id.signPub, id.boxPub)), false);
});

test("randomHandle is a valid 6-char handle within the alphabet", () => {
  const bytes = new Uint8Array([0, 61, 62, 123, 200, 255]);
  const h = randomHandle(bytes);
  assert.equal(h.length, HANDLE_LEN);
  assert.ok(isHandle(h));
});

test("randomHandle maps bytes deterministically (byte % 62)", () => {
  // 0→'0', 61→last alpha 'z', 62 wraps to '0' again.
  const h = randomHandle(new Uint8Array([0, 61, 62, 0, 0, 0]));
  assert.equal(h[0], "0");
  assert.equal(h[1], "z");
  assert.equal(h[2], "0");
});
