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
  respondHandle,
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
    assert.equal(avail.messages[0]?.from, "Alice");
    assert.equal(avail.messages[0]?.preview, "LAN party Saturday?");

    const read = await readMessage(bob, { id: avail.messages[0]!.id });
    assert.ok(read.ok && read.body === "LAN party Saturday?");
    // Reading clears the inbox.
    assert.equal((await messagesAvailable(bob)).count, 0);

    const reply = await sendMessage(bob, { in_reply_to: sentId, body: "I'm in." });
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
      { name: "Sam", signPub: x.signPub, boxPub: x.boxPub },
      { name: "Sam", signPub: y.signPub, boxPub: y.boxPub },
    ]);
    const r = await sendMessage(alice, { to: "Sam", body: "hi" });
    assert.equal(r.ok === false && r.reason, "ambiguous");
    assert.deepEqual(
      r.ok === false && r.reason === "ambiguous" ? r.candidates : null,
      ["Sam", "Sam"],
    );
  });

  test("a contact without keys returns no_keys", async () => {
    const alice = makeContext(mb.baseUrl, generateIdentity(), [{ name: "Keyless" }]);
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
    assert.ok(r.ok && "saved" in r && r.saved === true);
    // Saved for next time: a bare "write Bob" now resolves.
    assert.equal(alice.book.contacts.find((c) => c.name === "Bob")?.signPub, bobId.signPub);

    // Bob never consented to Alice, so on HIS side the first message is held
    // behind the new-handle gate (0.18): a summary only, until he accepts.
    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 0);
    assert.equal(avail.new_handles?.[0]?.count, 1);
    const accepted = respondHandle(bob, { name: avail.new_handles![0]!.name, action: "accept" });
    assert.ok(accepted.ok && accepted.action === "accept");
    assert.equal(accepted.ok && accepted.action === "accept" ? accepted.messages[0]?.body : "", "hi via code");
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
    const r = await sendMessage(bob, { in_reply_to: "nope", body: "x" });
    assert.equal(r.ok === false && r.reason, "not_found");
  });

  test("a reply to a self-introduced stranger now succeeds (they were auto-saved)", async () => {
    // Bob receives from a stranger he hasn't saved. Their message carries a
    // self-introduction (name + reply key), so Bob can answer — and they're
    // auto-saved for next time.
    const strangerId = generateIdentity();
    const stranger = makeContext(mb.baseUrl, strangerId);
    stranger.me.name = "Mallory";
    const bobId = generateIdentity();
    const bob = makeContext(mb.baseUrl, bobId);
    await regSelf(bob);
    await regSelf(stranger); // so Bob's reply can be delivered back
    stranger.book.contacts.push({ name: "Bob", signPub: bobId.signPub, boxPub: bobId.boxPub });
    const sent = await sendMessage(stranger, { to: "Bob", body: "who am I?" });
    assert.ok(sent.ok);
    await sync(bob);
    // Auto-saved under their own name.
    assert.equal(bob.book.contacts.find((c) => c.signPub === strangerId.signPub)?.name, "Mallory");
    const r = await sendMessage(bob, { in_reply_to: sent.ok ? sent.id : "", body: "hello!" });
    assert.ok(r.ok && r.to.name === "Mallory");
  });

  test("replying to a legacy (no self-introduction) stranger is still no_keys", async () => {
    // A message sealed WITHOUT the self-introduction envelope (an older client):
    // no reply key travels, so there's nothing to auto-save or reply to.
    const { seal } = await import("../../src/crypto.ts");
    const { randomUUID } = await import("node:crypto");
    const strangerId = generateIdentity();
    const bobId = generateIdentity();
    const bob = makeContext(mb.baseUrl, bobId);
    await regSelf(bob);
    const strangerClient = makeContext(mb.baseUrl, strangerId).client;
    const id = randomUUID();
    await strangerClient.send({
      id,
      recipient: bobId.signPub,
      sender: strangerId.signPub,
      body: seal("plain legacy body", bobId.boxPub), // raw text, no envelope
      tags: null,
      created_at: now(),
      in_reply_to: null,
    });
    await sync(bob);
    // Nothing auto-saved; the body still reads through as plain text.
    assert.equal(bob.book.contacts.length, 0);
    const read = await readMessage(bob, { id });
    assert.ok(read.ok && read.body === "plain legacy body");
    const r = await sendMessage(bob, { in_reply_to: id, body: "hello?" });
    assert.equal(r.ok === false && r.reason, "no_keys");
  });
});

describe("sender identity", () => {
  test("a new sender shows as 'Name (handle)' and is auto-saved", async () => {
    const aliceId = generateIdentity();
    const alice = makeContext(mb.baseUrl, aliceId);
    alice.me.name = "Alice";
    alice.me.handle = "alice1";
    const bobId = generateIdentity();
    const bob = makeContext(mb.baseUrl, bobId);
    await regSelf(bob);
    await regSelf(alice); // so Bob's "write Alice" reply can be delivered
    alice.book.contacts.push({ name: "Bob", signPub: bobId.signPub, boxPub: bobId.boxPub });

    await sendMessage(alice, { to: "Bob", body: "hi, new here" });
    // Held behind the gate first: the summary carries her self-name + handle.
    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 0);
    assert.equal(avail.new_handles?.[0]?.name, "Alice");
    assert.equal(avail.new_handles?.[0]?.handle, "alice1");
    // Auto-saved (gated), so a bare "write Alice" works — and counts as accepting.
    const sent = await sendMessage(bob, { to: "Alice", body: "welcome" });
    assert.ok(sent.ok && sent.to.name === "Alice");
    assert.equal(sent.ok && "acceptedHandle" in sent ? sent.acceptedHandle : undefined, true);
    // Accepted now: her held message flows, labelled "Name (handle)".
    const after = await messagesAvailable(bob);
    assert.equal(after.count, 1);
    assert.equal(after.messages[0]?.from, "Alice (alice1)");
  });

  test("your own nickname wins over the sender's self-name", async () => {
    const aliceId = generateIdentity();
    const alice = makeContext(mb.baseUrl, aliceId);
    alice.me.name = "Alice";
    alice.me.handle = "alice1";
    const bobId = generateIdentity();
    // Bob already calls her "Boss" — his nick must win, and no "(handle)" shown.
    const bob = makeContext(mb.baseUrl, bobId, [
      { name: "Boss", signPub: aliceId.signPub, boxPub: aliceId.boxPub },
    ]);
    await regSelf(bob);
    alice.book.contacts.push({ name: "Bob", signPub: bobId.signPub, boxPub: bobId.boxPub });

    await sendMessage(alice, { to: "Bob", body: "report?" });
    const avail = await messagesAvailable(bob);
    assert.equal(avail.messages[0]?.from, "Boss");
  });

  test("a known contact missing a handle gets it backfilled, nick untouched", async () => {
    const aliceId = generateIdentity();
    const alice = makeContext(mb.baseUrl, aliceId);
    alice.me.name = "Alice";
    alice.me.handle = "alice1";
    const bobId = generateIdentity();
    // Bob saved Alice as "Boss" BEFORE self-introductions existed: a real nick,
    // no handle on file. Her new-style envelope should fill the handle only.
    const bob = makeContext(mb.baseUrl, bobId, [
      { name: "Boss", signPub: aliceId.signPub, boxPub: aliceId.boxPub },
    ]);
    await regSelf(bob);
    alice.book.contacts.push({ name: "Bob", signPub: bobId.signPub, boxPub: bobId.boxPub });

    await sendMessage(alice, { to: "Bob", body: "ping" });
    await sync(bob);

    const saved = bob.book.contacts.find((c) => c.signPub === aliceId.signPub);
    assert.equal(saved?.handle, "alice1"); // backfilled
    assert.equal(saved?.name, "Boss"); // nick untouched
    assert.equal(saved?.auto, undefined); // not flipped to an auto contact
  });

  test("an existing handle is never overwritten by a later envelope", async () => {
    const aliceId = generateIdentity();
    const alice = makeContext(mb.baseUrl, aliceId);
    alice.me.name = "Alice";
    alice.me.handle = "alice2";
    const bobId = generateIdentity();
    // Bob already has a handle on file for Alice; a new message must not clobber it.
    const bob = makeContext(mb.baseUrl, bobId, [
      { name: "Boss", signPub: aliceId.signPub, boxPub: aliceId.boxPub, handle: "OLD123" },
    ]);
    await regSelf(bob);
    alice.book.contacts.push({ name: "Bob", signPub: bobId.signPub, boxPub: bobId.boxPub });

    await sendMessage(alice, { to: "Bob", body: "ping" });
    await sync(bob);

    const saved = bob.book.contacts.find((c) => c.signPub === aliceId.signPub);
    assert.equal(saved?.handle, "OLD123");
  });
});

describe("crypto boundaries", () => {
  test("a message sealed to the wrong identity is skipped, not surfaced or crashed", async () => {
    // Alice sends to Bob's signPub address but seals to a DIFFERENT box key.
    const aliceId = generateIdentity();
    const bobId = generateIdentity();
    const wrongBox = generateIdentity();
    const alice = makeContext(mb.baseUrl, aliceId, [
      { name: "Bob", signPub: bobId.signPub, boxPub: wrongBox.boxPub },
    ]);
    const bob = makeContext(mb.baseUrl, bobId);
    await regSelf(bob); // registered recipient; the seal, not the address, is wrong

    await sendMessage(alice, { to: "Bob", body: "you can't read this" });
    // A sealed box never becomes readable later, so an undecryptable blob is
    // dropped rather than cached as a phantom "[unable to decrypt]" message — and
    // draining it must not throw.
    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 0);
  });
});
