import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeSqliteStore } from "../../server-mailbox/store.ts";
import type { WireMessage } from "../../src/identity.ts";

function wire(over: Partial<WireMessage> = {}): WireMessage {
  return {
    id: "w1",
    recipient: "bob",
    sender: "alice",
    body: "ciphertext",
    tags: null,
    created_at: 1000,
    in_reply_to: null,
    ...over,
  };
}

test("put then summary lists waiting mail for the recipient", () => {
  const store = nodeSqliteStore(":memory:");
  store.put(wire());
  const s = store.summary("bob") as ReturnType<typeof Array.prototype.slice> & any[];
  assert.equal(s.length, 1);
  assert.equal(s[0].sender, "alice");
  assert.equal(s[0].id, "w1");
});

test("summary is scoped to the recipient", () => {
  const store = nodeSqliteStore(":memory:");
  store.put(wire({ id: "a", recipient: "bob" }));
  store.put(wire({ id: "b", recipient: "carol" }));
  assert.equal((store.summary("bob") as any[]).length, 1);
  assert.equal((store.summary("carol") as any[]).length, 1);
  assert.equal((store.summary("dave") as any[]).length, 0);
});

test("drain returns blobs then marks them fetched (one-shot)", () => {
  const store = nodeSqliteStore(":memory:");
  store.put(wire({ id: "a", created_at: 1 }));
  store.put(wire({ id: "b", created_at: 2 }));
  const first = store.drain("bob", 5000) as WireMessage[];
  assert.deepEqual(first.map((m) => m.id), ["a", "b"]);
  assert.equal(first[0].body, "ciphertext");
  // Already fetched → drains empty the second time, and summary clears.
  assert.equal((store.drain("bob", 6000) as WireMessage[]).length, 0);
  assert.equal((store.summary("bob") as any[]).length, 0);
});

test("registerHandle claims a free handle and is idempotent for the owner", () => {
  const store = nodeSqliteStore(":memory:");
  assert.equal(store.registerHandle("abc123", "alice-sign", "alice-box", 1), "ok");
  assert.equal(store.registerHandle("abc123", "alice-sign", "alice-box-rotated", 2), "ok");
  const rec = store.resolveHandle("abc123") as { signPub: string; boxPub: string };
  assert.equal(rec.signPub, "alice-sign");
  assert.equal(rec.boxPub, "alice-box-rotated"); // re-register updates the box key
});

test("registerHandle refuses a handle owned by someone else", () => {
  const store = nodeSqliteStore(":memory:");
  store.registerHandle("taken1", "alice-sign", "alice-box", 1);
  assert.equal(store.registerHandle("taken1", "mallory-sign", "mallory-box", 2), "taken");
  // Original owner's record is untouched.
  assert.equal((store.resolveHandle("taken1") as any).signPub, "alice-sign");
});

test("resolveHandle returns null for an unknown handle", () => {
  const store = nodeSqliteStore(":memory:");
  assert.equal(store.resolveHandle("ghost1"), null);
});

test("isRegistered is true only for a key with a claimed handle", () => {
  const store = nodeSqliteStore(":memory:");
  store.registerHandle("abc123", "alice-sign", "alice-box", 1);
  assert.equal(store.isRegistered("alice-sign"), true);
  assert.equal(store.isRegistered("nobody-sign"), false);
});

test("purge drops read mail past the read window and anything past the age window", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const s = nodeSqliteStore(":memory:");

  // read-stale: fetched 10d ago → past the 7d read window → deleted.
  s.put(wire({ id: "read-stale", created_at: now - 20 * DAY }));
  s.drain("bob", now - 10 * DAY);
  // read-fresh: fetched 1d ago → within the read window → kept.
  s.put(wire({ id: "read-fresh", created_at: now - 5 * DAY }));
  s.drain("bob", now - 1 * DAY);
  // unread-old: 40d old, never fetched → past the 30d age window → deleted.
  s.put(wire({ id: "unread-old", created_at: now - 40 * DAY }));
  // unread-new: 2d old, never fetched → kept.
  s.put(wire({ id: "unread-new", created_at: now - 2 * DAY }));

  const deleted = s.purge(now - 7 * DAY, now - 30 * DAY);
  assert.equal(deleted, 2); // read-stale + unread-old
  // Only the in-window unread message is still waiting for bob.
  assert.deepEqual(
    (s.summary("bob") as any[]).map((m) => m.id),
    ["unread-new"],
  );
});
