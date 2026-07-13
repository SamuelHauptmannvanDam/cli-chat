import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openMailbox,
  insertMessage,
  unreadFor,
  getMessage,
  markFetched,
  markRead,
  type MessageRow,
} from "../../src/db.ts";

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "m1",
    recipient: "me",
    sender: "them",
    body: "hello",
    tags: null,
    created_at: 1000,
    fetched_at: null,
    read_at: null,
    in_reply_to: null,
    ...over,
  };
}

test("openMailbox creates a usable messages table", () => {
  const db = openMailbox(":memory:");
  assert.deepEqual(unreadFor(db, "me"), []);
});

test("insertMessage then getMessage round-trips a row", () => {
  const db = openMailbox(":memory:");
  insertMessage(db, row());
  const got = getMessage(db, "m1");
  assert.equal(got?.body, "hello");
  assert.equal(got?.read_at, null);
});

test("getMessage returns undefined for an unknown id", () => {
  const db = openMailbox(":memory:");
  assert.equal(getMessage(db, "nope"), undefined);
});

test("unreadFor returns only this recipient's unread, oldest first", () => {
  const db = openMailbox(":memory:");
  insertMessage(db, row({ id: "b", created_at: 2000 }));
  insertMessage(db, row({ id: "a", created_at: 1000 }));
  insertMessage(db, row({ id: "other", recipient: "someone-else" }));
  insertMessage(db, row({ id: "read", created_at: 500, read_at: 9999 }));
  const unread = unreadFor(db, "me");
  assert.deepEqual(unread.map((m) => m.id), ["a", "b"]);
});

test("markRead sets read_at and back-fills fetched_at", () => {
  const db = openMailbox(":memory:");
  insertMessage(db, row());
  markRead(db, "m1", 4242);
  const got = getMessage(db, "m1");
  assert.equal(got?.read_at, 4242);
  assert.equal(got?.fetched_at, 4242);
  assert.deepEqual(unreadFor(db, "me"), []);
});

test("markFetched only sets fetched_at the first time (COALESCE)", () => {
  const db = openMailbox(":memory:");
  insertMessage(db, row());
  markFetched(db, "m1", 100);
  markFetched(db, "m1", 200);
  assert.equal(getMessage(db, "m1")?.fetched_at, 100);
});

test("inserting a duplicate id is a no-op, keeping the first row (INSERT OR IGNORE)", () => {
  // The warmer and read_messages can both drain + insert the same id concurrently,
  // so a duplicate must be ignored rather than throw a PRIMARY KEY error.
  const db = openMailbox(":memory:");
  insertMessage(db, row());
  assert.doesNotThrow(() => insertMessage(db, row({ body: "second" })));
  assert.equal(getMessage(db, "m1")?.body, "hello"); // first write wins, untouched
});
