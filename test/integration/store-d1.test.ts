// Parity guard for the D1 driver (store-d1.ts), which has no local Cloudflare
// runtime. We run its REAL SQL through node:sqlite via a tiny shim that mimics
// D1's `prepare().bind().run()/all()/first()` surface, after applying the
// shipped schema.sql. This catches the drift that eyeballing can't — a column
// typo, a wrong bind order, or a schema.sql that doesn't actually create what
// the driver queries — without needing wrangler/Miniflare. It does NOT cover
// D1-specific SQL dialect quirks (D1 is SQLite, so they're rare).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { d1Store, type D1Like } from "../../server-mailbox/store-d1.ts";
import type { WireMessage } from "../../src/core/wire.ts";

const SCHEMA = readFileSync(
  fileURLToPath(new URL("../../server-mailbox/schema.sql", import.meta.url)),
  "utf8",
);

// Wrap node:sqlite in the async D1 binding shape store-d1.ts expects.
function d1Shim(db: DatabaseSync): D1Like {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const r = stmt.run(...(args as any[]));
              return { meta: { changes: Number(r.changes ?? 0) } };
            },
            async all() {
              return { results: stmt.all(...(args as any[])) as unknown[] };
            },
            async first() {
              return (stmt.get(...(args as any[])) as unknown) ?? null;
            },
          };
        },
      };
    },
  };
}

function freshStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA); // also asserts schema.sql applies cleanly to a fresh DB
  return d1Store(d1Shim(db));
}

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

test("D1: put records the directed known pair (sender→recipient)", async () => {
  const store = freshStore();
  await store.put(wire({ sender: "alice", recipient: "bob" }));
  // Alice wrote to Bob → Bob is a known sender from Alice's inbox (reply exempt).
  assert.equal(await store.isKnownSender("alice", "bob"), true);
  // Reverse not implied: Alice is still unknown (throttled) from Bob's inbox.
  assert.equal(await store.isKnownSender("bob", "alice"), false);
});

test("D1: countRecentFromPair counts only this pair, by SERVER receive time", async () => {
  const store = freshStore();
  await store.put(wire({ id: "m1", sender: "alice", recipient: "bob", created_at: 0 }), 1000);
  await store.put(wire({ id: "m2", sender: "alice", recipient: "bob", created_at: 0 }), 2000);
  await store.put(wire({ id: "m3", sender: "carol", recipient: "bob", created_at: 0 }), 2000);
  assert.equal(await store.countRecentFromPair("bob", "alice", 1500), 1); // only m2 ≥ 1500
  assert.equal(await store.countRecentFromPair("bob", "alice", 0), 2);
  assert.equal(await store.countRecentFromPair("bob", "carol", 0), 1);
});

test("D1: countRecentUnknown excludes senders the recipient has replied to", async () => {
  const store = freshStore();
  await store.put(wire({ id: "s1", sender: "alice", recipient: "bob" }), 1000);
  await store.put(wire({ id: "s2", sender: "carol", recipient: "bob" }), 1000);
  assert.equal(await store.countRecentUnknown("bob", 0), 2);
  // Bob replies to Alice → Alice becomes known → drops out of the unknown count.
  await store.put(wire({ id: "r1", sender: "bob", recipient: "alice" }), 1500);
  assert.equal(await store.countRecentUnknown("bob", 0), 1); // only carol remains
});

test("D1: drain returns waiting mail then marks it fetched (one-shot)", async () => {
  const store = freshStore();
  await store.put(wire({ id: "a", created_at: 1 }));
  await store.put(wire({ id: "b", created_at: 2 }));
  const first = await store.drain("bob", 5000);
  assert.deepEqual(
    first.map((m) => m.id),
    ["a", "b"],
  );
  assert.equal((await store.drain("bob", 6000)).length, 0); // already fetched
});

test("D1: purge reports the deleted count via the meta.changes shape", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const store = freshStore();
  await store.put(wire({ id: "old-unread", created_at: now - 40 * DAY }));
  await store.put(wire({ id: "fresh-unread", created_at: now - 2 * DAY }));
  const deleted = await store.purge(now - 7 * DAY, now - 30 * DAY);
  assert.equal(deleted, 1); // only old-unread is past the age window
  assert.deepEqual(
    (await store.summary("bob")).map((m) => m.id),
    ["fresh-unread"],
  );
});

test("D1: handle registry register/resolve/isRegistered round-trips", async () => {
  const store = freshStore();
  assert.equal(await store.registerHandle("AbC123", "signpub-1", "boxpub-1", 1000), "ok");
  // Spread to a plain object: node:sqlite returns null-prototype rows, which
  // strict deep-equal treats as unequal to a literal even when fields match.
  assert.deepEqual({ ...(await store.resolveHandle("AbC123")) }, {
    signPub: "signpub-1",
    boxPub: "boxpub-1",
    requestsOnly: false, // FRIENDS.md: off by default
  });
  assert.equal(await store.resolveHandle("nope"), null);
  assert.equal(await store.isRegistered("signpub-1"), true);
  assert.equal(await store.isRegistered("ghost"), false);
  // A different key can't steal a claimed handle.
  assert.equal(await store.registerHandle("AbC123", "signpub-2", "boxpub-2", 2000), "taken");
});

test("D1: email stub lifecycle — upsert, once-ever notify, claim, provision count", async () => {
  const store = freshStore();
  const keys = { signPub: "stub-sign", boxPub: "stub-box", signSec: "sec-sign", boxSec: "sec-box" };
  await store.upsertEmailStub("Sam@Example.com", keys, "alice-pub", 1000);
  // Lowercased on write; read back whole (null-prototype row spread, as above).
  assert.deepEqual({ ...(await store.getEmailStub("sam@example.com")) }, {
    email: "sam@example.com",
    signPub: "stub-sign",
    boxPub: "stub-box",
    signSec: "sec-sign",
    boxSec: "sec-box",
    createdBy: "alice-pub",
    createdAt: 1000,
    notifiedAt: null,
  });
  // Stub signPubs accept mail without holding a handle (isRegistered carve-out).
  assert.equal(await store.isRegistered("stub-sign"), true);

  // The once-ever marker sets exactly once — a later mark never moves it.
  await store.markEmailNotified("sam@example.com", 1500);
  await store.markEmailNotified("sam@example.com", 9999);
  assert.equal((await store.getEmailStub("sam@example.com"))?.notifiedAt, 1500);

  // Claim drops the private halves; publics stay as the email → identity map.
  await store.claimEmailStub("stub-sign");
  const claimed = await store.getEmailStub("sam@example.com");
  assert.equal(claimed?.signSec, null);
  assert.equal(claimed?.boxSec, null);
  assert.equal(claimed?.signPub, "stub-sign");

  // Provision cap counts by creator within the window.
  assert.equal(await store.countRecentEmailProvisions("alice-pub", 0), 1);
  assert.equal(await store.countRecentEmailProvisions("alice-pub", 2000), 0);
});

test("D1: purgeEmailStubs spares waiting mail and claimed stubs, keeps the tombstone across re-keys", async () => {
  const store = freshStore();
  await store.upsertEmailStub(
    "old@example.com",
    { signPub: "old-sign", boxPub: "old-box", signSec: "s", boxSec: "b" },
    "alice-pub",
    1000,
  );
  await store.markEmailNotified("old@example.com", 1200);

  // Unread mail waiting → spared even past the cutoff.
  await store.put(wire({ id: "held", recipient: "old-sign" }));
  assert.equal(await store.purgeEmailStubs(5000), 0);

  // Mail drained → the keys purge; the row and its notified_at remain.
  await store.drain("old-sign", 2000);
  assert.equal(await store.purgeEmailStubs(5000), 1);
  const row = await store.getEmailStub("old@example.com");
  assert.equal(row?.signPub, null);
  assert.equal(row?.notifiedAt, 1200);

  // A later resolve re-keys the same row: fresh keys and retention clock, same tombstone.
  await store.upsertEmailStub(
    "old@example.com",
    { signPub: "new-sign", boxPub: "new-box", signSec: "s2", boxSec: "b2" },
    "carol-pub",
    8000,
  );
  const rekeyed = await store.getEmailStub("old@example.com");
  assert.equal(rekeyed?.signPub, "new-sign");
  assert.equal(rekeyed?.createdAt, 8000);
  assert.equal(rekeyed?.createdBy, "carol-pub");
  assert.equal(rekeyed?.notifiedAt, 1200);

  // A claimed stub (sign_sec already NULL) is never a purge candidate.
  await store.claimEmailStub("new-sign");
  assert.equal(await store.purgeEmailStubs(99999), 0);
  assert.equal((await store.getEmailStub("old@example.com"))?.signPub, "new-sign");
});

test("D1: waiting-mail sweep — candidates, marker, drain re-arm, opt-out (NOTIFY-EMAIL.md)", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const store = freshStore();
  await store.registerHandle("alice1", "alice", "alice-box", 1000, "Alice Ant");
  const acc = await store.getOrCreateAccount("bob@example.com", 1000);
  await store.bindAccountSignPub(acc.id, "bob", 1000);
  await store.put(wire({ id: "n1", sender: "alice", recipient: "bob" }), 1000);
  await store.put(wire({ id: "self", sender: "bob", recipient: "bob" }), 1000); // never counts

  // Candidate carries the account email, the non-self count, and sender names.
  const found = await store.unreadEmailCandidates(1000 + DAY, 50);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.email, "bob@example.com");
  assert.equal(found[0]!.signPub, "bob");
  assert.equal(found[0]!.count, 1);
  assert.deepEqual(found[0]!.senderNames, ["Alice Ant"]);

  // Marker set → out of the candidate pool; drain re-arms; opt-out wins over both.
  await store.markUnreadNotified("bob", 2000);
  assert.equal((await store.unreadEmailCandidates(1000 + DAY, 50)).length, 0);
  await store.clearUnreadNotified("bob");
  assert.equal((await store.unreadEmailCandidates(1000 + DAY, 50)).length, 1);
  await store.setUnreadEmails("bob", false, 3000);
  assert.equal((await store.unreadEmailCandidates(1000 + DAY, 50)).length, 0);
  await store.setUnreadEmails("bob", true, 4000);

  // Too-young mail doesn't qualify; an account without a bound signPub never appears.
  assert.equal((await store.unreadEmailCandidates(1000, 50)).length, 0);
  await store.getOrCreateAccount("ghost@example.com", 1000);
  const again = await store.unreadEmailCandidates(1000 + DAY, 50);
  assert.deepEqual(again.map((c) => c.email), ["bob@example.com"]);
});
