// The warmer→hook pending-snapshot channel (core-net refreshPending/readPending/
// writePendingAck). Proves the hook can see unread mail WITHOUT opening inbox.db,
// and that read-state is only advanced when the hook acks — never at queue time.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCrypto, generateIdentity } from "../../src/core/crypto.ts";
import { openMailbox, insertMessage, unreadFor, type MessageRow } from "../../src/db.ts";
import {
  refreshPending,
  readPending,
  writePendingAck,
  type NetContext,
} from "../../src/core-net.ts";
import type { ContactBook } from "../../src/contacts.ts";

before(() => initCrypto());

function row(over: Partial<MessageRow>): MessageRow {
  return {
    id: "m",
    recipient: "me",
    sender: "them",
    body: "hi",
    tags: null,
    created_at: 1,
    fetched_at: 1,
    read_at: null,
    in_reply_to: null,
    ...over,
  };
}

test("refreshPending mirrors unread to pending.json; an ack marks read and drops it", () => {
  const me = generateIdentity();
  const sender = generateIdentity();
  const book: ContactBook = {
    me: me.signPub,
    contacts: [{ name: "Ann", signPub: sender.signPub, boxPub: sender.boxPub }],
  };
  const cache = openMailbox(":memory:");
  const ctx = { me, book, cache, client: {}, now: () => 1000 } as unknown as NetContext;

  insertMessage(cache, row({ id: "m1", recipient: me.signPub, sender: sender.signPub, body: "body m1" }));
  insertMessage(cache, row({ id: "m2", recipient: me.signPub, sender: sender.signPub, body: "body m2" }));

  const dir = mkdtempSync(join(tmpdir(), "clim-pending-"));
  const pendingPath = join(dir, "pending.json");
  const ackPath = join(dir, "pending-ack.json");
  try {
    refreshPending(ctx, pendingPath, ackPath);
    const snap = readPending(pendingPath);
    assert.equal(snap?.messages.length, 2);
    assert.equal(snap?.messages[0]?.from, "Ann"); // senderLabel applied warmer-side
    assert.equal(snap?.messages[0]?.body, "body m1");
    // Mirroring alone must NOT mark anything read (else read_messages would be starved).
    assert.equal(unreadFor(cache, me.signPub).length, 2);

    // Hook surfaced m1 and acked it; the warmer's next refresh applies the ack.
    writePendingAck(ackPath, ["m1"]);
    refreshPending(ctx, pendingPath, ackPath);
    assert.deepEqual(unreadFor(cache, me.signPub).map((m) => m.id), ["m2"]); // m1 now read
    assert.deepEqual(readPending(pendingPath)?.messages.map((m) => m.id), ["m2"]); // dropped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPending returns null with no snapshot, so the hook falls back to a direct drain", () => {
  assert.equal(readPending(join(tmpdir(), "clim-no-such-pending-xyz.json")), null);
});
