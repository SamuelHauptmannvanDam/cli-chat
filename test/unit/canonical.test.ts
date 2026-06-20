import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, MAX_SKEW_MS } from "../../src/canonical.ts";

test("canonical joins method/path/timestamp/body with newlines", () => {
  assert.equal(canonical("POST", "/messages", 123, "hi"), "POST\n/messages\n123\nhi");
});

test("canonical upper-cases the method", () => {
  assert.equal(canonical("get", "/mailbox", 0, ""), "GET\n/mailbox\n0\n");
});

test("canonical is deterministic for identical inputs", () => {
  assert.equal(canonical("GET", "/x", 9, "b"), canonical("GET", "/x", 9, "b"));
});

test("canonical distinguishes path, timestamp, and body", () => {
  const base = canonical("GET", "/a", 1, "b");
  assert.notEqual(base, canonical("GET", "/a2", 1, "b"));
  assert.notEqual(base, canonical("GET", "/a", 2, "b"));
  assert.notEqual(base, canonical("GET", "/a", 1, "b2"));
});

test("MAX_SKEW_MS is five minutes", () => {
  assert.equal(MAX_SKEW_MS, 5 * 60 * 1000);
});
