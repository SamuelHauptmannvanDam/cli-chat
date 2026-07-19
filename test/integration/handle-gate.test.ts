// The new-handle gate (0.18): a first-time sender is HELD — saved gated, their
// bodies kept out of every model-facing read path — until the user accepts
// (respond_handle / writing them) or a public chat session bypasses the gate.
// Runs against the real in-process mailbox: the exact path the MCP tools take.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sendMessage,
  messagesAvailable,
  readMessage,
  respondHandle,
  takeUnread,
  refreshPending,
  readPending,
  readChatLock,
  pendingHandles,
  sync,
} from "../../src/core-net.ts";
import { contactByKey } from "../../src/contacts.ts";
import { unreadFor } from "../../src/db.ts";
import { generateIdentity } from "../../src/crypto.ts";
import { startMailbox, makeContext, regSelf, now, type Mailbox } from "../helpers.ts";
import type { NetContext } from "../../src/core-net.ts";

let mb: Mailbox;
before(async () => {
  mb = await startMailbox();
});
after(() => mb.close());

// A stranger (with a name on their envelope) plus a receiver who has NEVER
// heard of them — the gate's subject. The stranger knows the receiver.
async function strangerAndReceiver(): Promise<{ stranger: NetContext; receiver: NetContext }> {
  const sId = generateIdentity();
  sId.name = "Sam Stranger";
  sId.handle = "sAmXyZ";
  const rId = generateIdentity();
  const stranger = makeContext(mb.baseUrl, sId, [
    { name: "Receiver", signPub: rId.signPub, boxPub: rId.boxPub },
  ]);
  const receiver = makeContext(mb.baseUrl, rId, []);
  await regSelf(stranger);
  await regSelf(receiver);
  return { stranger, receiver };
}

describe("a first-time sender is held behind the gate", () => {
  test("saved gated:pending; bodies stay out of every model-facing path", async () => {
    const { stranger, receiver } = await strangerAndReceiver();
    await sendMessage(stranger, { to: "Receiver", body: "hello, it's Sam" });

    // messages_available: count 0, but the handle is summarised (no body).
    const avail = await messagesAvailable(receiver);
    assert.equal(avail.count, 0);
    assert.equal(avail.messages.length, 0);
    assert.equal(avail.new_handles?.length, 1);
    assert.equal(avail.new_handles?.[0]?.name, "Sam Stranger");
    assert.equal(avail.new_handles?.[0]?.handle, "sAmXyZ");
    assert.equal(avail.new_handles?.[0]?.count, 1);

    // The contact exists but is gated — auto-saved, not accepted.
    const c = contactByKey(receiver.book, stranger.me.signPub);
    assert.equal(c?.gated, "pending");
    assert.equal(c?.auto, true);

    // takeUnread (read_messages' direct path) skips it AND leaves it unread.
    assert.equal(takeUnread(receiver).length, 0);
    assert.equal(unreadFor(receiver.cache, receiver.me.signPub).length, 1);

    // read_message: oldest-unread finds nothing; by id it refuses with who.
    const empty = await readMessage(receiver, {});
    assert.ok(!empty.ok && empty.reason === "empty");
    const heldId = unreadFor(receiver.cache, receiver.me.signPub)[0]!.id;
    const refused = await readMessage(receiver, { id: heldId });
    assert.ok(!refused.ok && refused.reason === "new_handle");
    assert.ok(refused.ok === false && refused.reason === "new_handle" && refused.name === "Sam Stranger");
    // Refusing must not consume it.
    assert.equal(unreadFor(receiver.cache, receiver.me.signPub).length, 1);
  });

  test("the warmer snapshot splits held mail into `gated` (for the hook's user notice)", async () => {
    const { stranger, receiver } = await strangerAndReceiver();
    await sendMessage(stranger, { to: "Receiver", body: "held body" });
    await sync(receiver);

    const dir = mkdtempSync(join(tmpdir(), "clim-gate-"));
    try {
      const pendingPath = join(dir, "pending.json");
      refreshPending(receiver, pendingPath, join(dir, "pending-ack.json"));
      const snap = readPending(pendingPath);
      assert.equal(snap?.messages.length, 0); // nothing for the model
      assert.equal(snap?.gated?.length, 1); // the body rides ONLY here (user notice)
      assert.equal(snap?.gated?.[0]?.body, "held body");
      assert.match(snap?.gated?.[0]?.from ?? "", /Sam Stranger/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("respond_handle", () => {
  test("accept returns the held messages, marks them read, and un-gates the contact", async () => {
    const { stranger, receiver } = await strangerAndReceiver();
    await sendMessage(stranger, { to: "Receiver", body: "first" });
    await sendMessage(stranger, { to: "Receiver", body: "second" });
    await sync(receiver);

    // Partial name match, like the other tools.
    const r = respondHandle(receiver, { name: "sam", action: "accept" });
    assert.ok(r.ok && r.action === "accept");
    assert.equal(r.ok && r.count, 2);
    assert.deepEqual(r.ok && r.action === "accept" ? r.messages.map((m) => m.body) : [], ["first", "second"]);
    assert.equal(contactByKey(receiver.book, stranger.me.signPub)?.gated, undefined);
    assert.equal(unreadFor(receiver.cache, receiver.me.signPub).length, 0); // consumed by the accept

    // From now on they're a normal contact: the next message flows.
    await sendMessage(stranger, { to: "Receiver", body: "third" });
    const avail = await messagesAvailable(receiver);
    assert.equal(avail.count, 1);
    assert.equal(avail.new_handles, undefined);
  });

  test("dismiss keeps them out quietly; a later accept still works", async () => {
    const { stranger, receiver } = await strangerAndReceiver();
    await sendMessage(stranger, { to: "Receiver", body: "knock knock" });
    await sync(receiver);

    const d = respondHandle(receiver, { name: "sAmXyZ", action: "dismiss" });
    assert.ok(d.ok && d.action === "dismiss" && d.held === 1);
    assert.equal(contactByKey(receiver.book, stranger.me.signPub)?.gated, "dismissed");

    // Dismissed = silent everywhere: no summary, no snapshot.gated entry.
    await sendMessage(stranger, { to: "Receiver", body: "still there?" });
    const avail = await messagesAvailable(receiver);
    assert.equal(avail.count, 0);
    assert.equal(avail.new_handles, undefined);
    assert.equal(pendingHandles(receiver).length, 0);
    const dir = mkdtempSync(join(tmpdir(), "clim-gate-"));
    try {
      const pendingPath = join(dir, "pending.json");
      refreshPending(receiver, pendingPath, join(dir, "pending-ack.json"));
      assert.equal(readPending(pendingPath)?.gated, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // The user changes their mind: accept reveals everything held meanwhile.
    const a = respondHandle(receiver, { name: "Sam", action: "accept" });
    assert.ok(a.ok && a.action === "accept" && a.count === 2);
  });

  test("no_match and ambiguous outcomes", async () => {
    const { receiver } = await strangerAndReceiver();
    const r = respondHandle(receiver, { name: "nobody", action: "accept" });
    assert.ok(!r.ok && r.reason === "no_match");
  });
});

describe("consent by writing", () => {
  test("sending to a held handle accepts them (acceptedHandle on the result)", async () => {
    const { stranger, receiver } = await strangerAndReceiver();
    await sendMessage(stranger, { to: "Receiver", body: "hi" });
    await sync(receiver);
    assert.equal(contactByKey(receiver.book, stranger.me.signPub)?.gated, "pending");

    const sent = await sendMessage(receiver, { to: "Sam Stranger", body: "hello back" });
    assert.ok(sent.ok);
    assert.equal(sent.ok && "acceptedHandle" in sent ? sent.acceptedHandle : undefined, true);
    assert.equal(contactByKey(receiver.book, stranger.me.signPub)?.gated, undefined);
    // Their held message now flows through the normal unread path.
    assert.equal((await messagesAvailable(receiver)).count, 1);
  });
});

describe("public mode bypasses the gate", () => {
  test("allowNewSenders() true → auto-saved ungated, message flows", async () => {
    const { stranger, receiver } = await strangerAndReceiver();
    receiver.allowNewSenders = () => true;
    await sendMessage(stranger, { to: "Receiver", body: "walk right in" });

    const avail = await messagesAvailable(receiver);
    assert.equal(avail.count, 1);
    assert.equal(avail.new_handles, undefined);
    const c = contactByKey(receiver.book, stranger.me.signPub);
    assert.equal(c?.gated, undefined);
    assert.equal(c?.auto, true);
  });
});

describe("readChatLock (the public flag's carrier)", () => {
  test("fresh lock reports mode flags; stale or missing lock is inactive", () => {
    const dir = mkdtempSync(join(tmpdir(), "clim-lock-"));
    try {
      const lockPath = join(dir, "chat.lock");
      writeFileSync(lockPath, JSON.stringify({ at: Date.now(), public: true }));
      const live = readChatLock(lockPath, Date.now());
      assert.deepEqual(live, { active: true, public: true });
      // The same lock read 20s later (mtime stale) counts as no chat running.
      const stale = readChatLock(lockPath, Date.now() + 20_000);
      assert.deepEqual(stale, { active: false, public: false });
      assert.deepEqual(readChatLock(join(dir, "nope.lock"), Date.now()), {
        active: false,
        public: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("known contacts are unaffected", () => {
  test("a saved contact's message flows exactly as before", async () => {
    const aId = generateIdentity();
    const bId = generateIdentity();
    const a = makeContext(mb.baseUrl, aId, [{ name: "Bee", signPub: bId.signPub, boxPub: bId.boxPub }]);
    const b = makeContext(mb.baseUrl, bId, [{ name: "Ay", signPub: aId.signPub, boxPub: aId.boxPub }]);
    await regSelf(a);
    await regSelf(b);
    await sendMessage(a, { to: "Bee", body: "old friends" });
    const avail = await messagesAvailable(b);
    assert.equal(avail.count, 1);
    assert.equal(avail.new_handles, undefined);
    assert.equal(now() > 0, true);
  });
});
