import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("put records the sender→recipient pair as known (for reply exemption)", () => {
  const store = nodeSqliteStore(":memory:");
  store.put(wire({ sender: "alice", recipient: "bob" }));
  // Alice wrote to Bob, so when Bob replies, Bob is a known sender to Alice —
  // i.e. from Alice's inbox, Bob is exempt from new-sender throttling.
  assert.equal(store.isKnownSender("alice", "bob"), true);
  // The reverse isn't implied — Bob hasn't written to Alice, so Alice is still
  // an unknown (throttled) sender from Bob's inbox.
  assert.equal(store.isKnownSender("bob", "alice"), false);
});

test("countRecentFromPair counts only this pair, by SERVER receive time", () => {
  const store = nodeSqliteStore(":memory:");
  // created_at is attacker-controlled (all 0 here); receivedAt is the server's.
  store.put(wire({ id: "m1", sender: "alice", recipient: "bob", created_at: 0 }), 1000);
  store.put(wire({ id: "m2", sender: "alice", recipient: "bob", created_at: 0 }), 2000);
  store.put(wire({ id: "m3", sender: "carol", recipient: "bob", created_at: 0 }), 2000);
  assert.equal(store.countRecentFromPair("bob", "alice", 1500), 1); // only m2 ≥ 1500
  assert.equal(store.countRecentFromPair("bob", "alice", 0), 2);
  assert.equal(store.countRecentFromPair("bob", "carol", 0), 1);
});

test("countRecentUnknown excludes senders the recipient has replied to", () => {
  const store = nodeSqliteStore(":memory:");
  // Two strangers write to Bob.
  store.put(wire({ id: "s1", sender: "alice", recipient: "bob" }), 1000);
  store.put(wire({ id: "s2", sender: "carol", recipient: "bob" }), 1000);
  assert.equal(store.countRecentUnknown("bob", 0), 2);
  // Bob replies to Alice → Alice becomes known → drops out of the unknown count.
  store.put(wire({ id: "r1", sender: "bob", recipient: "alice" }), 1500);
  assert.equal(store.countRecentUnknown("bob", 0), 1); // only carol remains
});

test("countRecentSentToNew counts a sender's cold outreach (people who don't know them)", () => {
  const store = nodeSqliteStore(":memory:");
  store.put(wire({ id: "a", sender: "spammer", recipient: "r1" }), 1000);
  store.put(wire({ id: "b", sender: "spammer", recipient: "r2" }), 1000);
  assert.equal(store.countRecentSentToNew("spammer", 0), 2);
  // r1 writes back → spammer is now known to r1 → that send no longer counts cold.
  store.put(wire({ id: "c", sender: "r1", recipient: "spammer" }), 1500);
  assert.equal(store.countRecentSentToNew("spammer", 0), 1); // only the r2 send is still cold
  // Window is by server receive time (both sends landed at 1000).
  assert.equal(store.countRecentSentToNew("spammer", 1200), 0);
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

test("opening a legacy DB (no received_at) self-heals before indexing admission", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-chat-store-"));
  const path = join(dir, "legacy.db");
  try {
    // Seed the pre-received_at schema a deployed/old DB would have.
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, recipient TEXT NOT NULL, sender TEXT NOT NULL,
        body TEXT NOT NULL, tags TEXT, created_at INTEGER NOT NULL,
        fetched_at INTEGER, in_reply_to TEXT
      );
      INSERT INTO messages (id, recipient, sender, body, created_at)
      VALUES ('old', 'bob', 'alice', 'ciphertext', 1000);
    `);
    seed.close();

    // Opening must NOT throw at idx_admission, and admission must work afterward.
    const store = nodeSqliteStore(path);
    store.put(wire({ id: "new", sender: "carol", recipient: "bob" }), 2000);
    assert.equal(store.countRecentFromPair("bob", "carol", 0), 1);
    // The pre-existing row had no received_at, so it's not counted by receive time.
    assert.equal(store.countRecentFromPair("bob", "alice", 0), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
