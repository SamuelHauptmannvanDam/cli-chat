// End-to-end through the real stack: core-net operations → signed HTTP client →
// in-process Hono mailbox → SQLite store, with sealed-box E2E in between. This
// is the path the MCP tools take. Covers the happy loop plus the failure
// branches (unknown/ambiguous contact, missing keys, decrypt failure, handle
// onboarding).

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sendMessage,
  messagesAvailable,
  readMessage,
  draftReply,
  addContact,
  sync,
} from "../../src/core-net.ts";
import { generateIdentity } from "../../src/crypto.ts";
import { startMailbox, makeContext, twoUsers, regSelf, now, type Mailbox } from "../helpers.ts";

let mb: Mailbox;
before(async () => {
  mb = await startMailbox();
});
after(() => mb.close());

describe("happy path: send → available → read → reply", () => {
  test("a sealed message travels Alice → Bob and a threaded reply comes back", async () => {
    const { a: alice, b: bob } = await twoUsers(mb.baseUrl);

    const sent = await sendMessage(alice, { to: "Bob", body: "LAN party Saturday?" });
    assert.ok(sent.ok && sent.to.name === "Bob");
    const sentId = sent.ok ? sent.id : "";

    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 1);
    assert.equal(avail.messages[0].from, "Alice");
    assert.equal(avail.messages[0].preview, "LAN party Saturday?");

    const read = await readMessage(bob, { id: avail.messages[0].id });
    assert.ok(read.ok && read.body === "LAN party Saturday?");
    // Reading clears the inbox.
    assert.equal((await messagesAvailable(bob)).count, 0);

    const reply = await draftReply(bob, { in_reply_to: sentId, body: "I'm in." });
    assert.ok(reply.ok && reply.to.name === "Alice");

    const back = await readMessage(alice, {});
    assert.ok(back.ok && back.body === "I'm in.");
    assert.equal(back.ok && back.in_reply_to, sentId);
  });
});

describe("read_message addressing", () => {
  test("read with no id returns the oldest unread", async () => {
    const { a: alice, b: bob } = await twoUsers(mb.baseUrl);
    await sendMessage(alice, { to: "Bob", body: "first" });
    await sendMessage(alice, { to: "Bob", body: "second" });
    const r = await readMessage(bob, {});
    assert.ok(r.ok && r.body === "first");
  });

  test("read of an unknown id is not_found", async () => {
    const { b: bob } = await twoUsers(mb.baseUrl);
    const r = await readMessage(bob, { id: "does-not-exist" });
    assert.equal(r.ok === false && r.reason, "not_found");
  });

  test("read on an empty inbox is empty", async () => {
    const { b: bob } = await twoUsers(mb.baseUrl);
    const r = await readMessage(bob, {});
    assert.equal(r.ok === false && r.reason, "empty");
  });
});

describe("send failures", () => {
  test("sending to an unknown name returns no_contact", async () => {
    const alice = makeContext(mb.baseUrl, generateIdentity());
    const r = await sendMessage(alice, { to: "Stranger", body: "hi" });
    assert.equal(r.ok === false && r.reason, "no_contact");
  });

  test("sending to an ambiguous name returns ambiguous with candidates", async () => {
    const me = generateIdentity();
    const x = generateIdentity();
    const y = generateIdentity();
    const alice = makeContext(mb.baseUrl, me, [
      { id: "sam1", name: "Sam", signPub: x.signPub, boxPub: x.boxPub },
      { id: "sam2", name: "Sam", signPub: y.signPub, boxPub: y.boxPub },
    ]);
    const r = await sendMessage(alice, { to: "Sam", body: "hi" });
    assert.equal(r.ok === false && r.reason, "ambiguous");
    assert.deepEqual(r.ok === false ? r.candidates : null, ["Sam", "Sam"]);
  });

  test("a contact without keys returns no_keys", async () => {
    const alice = makeContext(mb.baseUrl, generateIdentity(), [{ id: "x", name: "Keyless" }]);
    const r = await sendMessage(alice, { to: "Keyless", body: "hi" });
    assert.equal(r.ok === false && r.reason, "no_keys");
  });

  test("an unknown name with a bad key code returns bad_key", async () => {
    const alice = makeContext(mb.baseUrl, generateIdentity());
    const r = await sendMessage(alice, { to: "New", body: "hi", key: "not-a-key" });
    assert.equal(r.ok === false && r.reason, "bad_key");
  });
});

describe("onboarding by code", () => {
  test("send to a new person via their full key code saves them and delivers", async () => {
    const alice = makeContext(mb.baseUrl, generateIdentity());
    const bobId = generateIdentity();
    const bob = makeContext(mb.baseUrl, bobId);
    await regSelf(bob); // Bob is a real account → has a handle on file
    const { encodeKey } = await import("../../src/key-code.ts");
    const code = encodeKey(bobId.signPub, bobId.boxPub);

    const r = await sendMessage(alice, { to: "Bob", body: "hi via code", key: code });
    assert.ok(r.ok && r.saved === true);
    // Saved for next time: a bare "write Bob" now resolves.
    assert.equal(alice.book.contacts.find((c) => c.name === "Bob")?.signPub, bobId.signPub);

    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 1);
    assert.equal(avail.messages[0].preview, "hi via code");
  });

  test("addContact resolves a registered handle to keys", async () => {
    const bobId = generateIdentity();
    const bob = makeContext(mb.baseUrl, bobId);
    await bob.client.registerHandle("bobbb1");

    const alice = makeContext(mb.baseUrl, generateIdentity());
    const r = await addContact(alice, { name: "Bob", key: "bobbb1" });
    assert.ok(r.ok);
    const saved = alice.book.contacts.find((c) => c.name === "Bob");
    assert.equal(saved?.signPub, bobId.signPub);
    assert.equal(saved?.boxPub, bobId.boxPub);
  });

  test("addContact persists the book to disk when contactsPath is set", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "clim-book-"));
    const path = join(dir, "contacts.json");

    const bobId = generateIdentity();
    const bob = makeContext(mb.baseUrl, bobId);
    await bob.client.registerHandle("save01");

    const alice = makeContext(mb.baseUrl, generateIdentity());
    alice.contactsPath = path;
    try {
      const r = await addContact(alice, { name: "Bob", key: "save01" });
      assert.ok(r.ok);
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(onDisk.contacts[0].signPub, bobId.signPub);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("addContact with an unknown handle returns not_found", async () => {
    const alice = makeContext(mb.baseUrl, generateIdentity());
    const r = await addContact(alice, { name: "Ghost", key: "zzzzzz" });
    assert.equal(r.ok === false && r.reason, "not_found");
  });

  test("addContact with junk returns bad_key", async () => {
    const alice = makeContext(mb.baseUrl, generateIdentity());
    const r = await addContact(alice, { name: "X", key: "!!" });
    assert.equal(r.ok === false && r.reason, "bad_key");
  });
});

describe("reply failures", () => {
  test("replying to an unknown message is not_found", async () => {
    const { b: bob } = await twoUsers(mb.baseUrl);
    const r = await draftReply(bob, { in_reply_to: "nope", body: "x" });
    assert.equal(r.ok === false && r.reason, "not_found");
  });

  test("replying to a sender who isn't in the book is no_keys", async () => {
    // Bob receives from a stranger he hasn't saved, then tries to reply.
    const strangerId = generateIdentity();
    const stranger = makeContext(mb.baseUrl, strangerId);
    const bobId = generateIdentity();
    const bob = makeContext(mb.baseUrl, bobId, [
      // Bob knows the stranger's keys well enough to receive, but we omit them
      // from his book so the reply lookup fails.
    ]);
    await regSelf(bob); // Bob is a real account → registered recipient
    // Stranger needs Bob in their book to send.
    stranger.book.contacts.push({ id: "bob", name: "Bob", signPub: bobId.signPub, boxPub: bobId.boxPub });
    const sent = await sendMessage(stranger, { to: "Bob", body: "who am I?" });
    assert.ok(sent.ok);
    await sync(bob);
    const r = await draftReply(bob, { in_reply_to: sent.ok ? sent.id : "", body: "hello?" });
    assert.equal(r.ok === false && r.reason, "no_keys");
  });
});

describe("crypto boundaries", () => {
  test("a message sealed to the wrong identity surfaces as undecryptable, not a crash", async () => {
    // Alice sends to Bob's signPub address but seals to a DIFFERENT box key.
    const aliceId = generateIdentity();
    const bobId = generateIdentity();
    const wrongBox = generateIdentity();
    const alice = makeContext(mb.baseUrl, aliceId, [
      { id: "bob", name: "Bob", signPub: bobId.signPub, boxPub: wrongBox.boxPub },
    ]);
    const bob = makeContext(mb.baseUrl, bobId);
    await regSelf(bob); // registered recipient; the seal, not the address, is wrong

    await sendMessage(alice, { to: "Bob", body: "you can't read this" });
    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 1);
    assert.match(avail.messages[0].preview, /unable to decrypt/);
  });
});
