// Group chats (GROUPS: 0.24) through the real stack: multi-recipient sends
// create a shared thread, envelopes carry the roster, receivers cohere copies
// by the shared mid, replies fan to everyone, and the roster tool's ops
// propagate. Includes the adversarial checks BOTH ways:
//   false positive — a stranger's forged group claim must NOT clear the gate
//                    or rewrite a stored roster;
//   false negative — a genuine member of a known group must NOT be held.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sendMessage,
  messagesAvailable,
  readMessage,
  messageHistory,
  createGroup,
  manageGroup,
  listGroups,
  packBody,
  sync,
  type NetContext,
  type WireGroup,
} from "../../src/core-net.ts";
import { seal, generateIdentity } from "../../src/crypto.ts";
import { contactByKey, groupById } from "../../src/contacts.ts";
import { startMailbox, makeContext, regSelf, now, type Mailbox } from "../helpers.ts";

let mb: Mailbox;
before(async () => {
  mb = await startMailbox();
});
after(() => mb.close());

// Alice knows Bob and Carol; Bob and Carol each know only Alice (NOT each
// other) — the shape that exercises the membership-vouching rule.
async function trio() {
  const aId = generateIdentity();
  const bId = generateIdentity();
  const cId = generateIdentity();
  const alice = makeContext(mb.baseUrl, aId, [
    { name: "Bob", signPub: bId.signPub, boxPub: bId.boxPub },
    { name: "Carol", signPub: cId.signPub, boxPub: cId.boxPub },
  ]);
  const bob = makeContext(mb.baseUrl, bId, [
    { name: "Alice", signPub: aId.signPub, boxPub: aId.boxPub },
  ]);
  const carol = makeContext(mb.baseUrl, cId, [
    { name: "Alice", signPub: aId.signPub, boxPub: aId.boxPub },
  ]);
  await regSelf(alice);
  await regSelf(bob);
  await regSelf(carol);
  return { alice, bob, carol, aId, bId, cId };
}

describe("multi-recipient send = group chat by default", () => {
  test("creating, reusing, threading, and reply-all across three members", async () => {
    const { alice, bob, carol, aId, bId } = await trio();

    // "write Bob, Carol: hey team" → a group is born.
    const first = await sendMessage(alice, { to: "Bob, Carol", body: "hey team" });
    assert.ok(first.ok);
    assert.ok(first.ok && first.group, "multi-recipient send must return a group result");
    const g1 = first.ok && first.group ? first.group : undefined;
    assert.equal(g1?.created, true);
    assert.deepEqual([...(g1?.members ?? [])].sort(), ["Bob", "Carol"]);
    assert.equal(alice.book.groups?.length, 1);

    // Same set, different order → the SAME group, not a second one.
    const second = await sendMessage(alice, { to: "Carol, Bob", body: "second" });
    assert.ok(second.ok && second.group);
    assert.equal(second.ok && second.group?.id, g1?.id);
    assert.equal(second.ok && second.group?.created, undefined);
    assert.equal(alice.book.groups?.length, 1);

    // Bob receives both, tagged with the group, and learns the roster.
    const bAvail = await messagesAvailable(bob);
    assert.equal(bAvail.count, 2);
    assert.equal(bAvail.messages[0]?.group, g1?.name);
    const bobGroup = groupById(bob.book, g1!.id);
    assert.ok(bobGroup, "Bob learns the group from the envelope");
    assert.equal(bobGroup?.members.length, 2); // Alice + Carol
    assert.ok(bobGroup?.members.some((m) => m.signPub === aId.signPub));

    // The shared mid: Bob's copy is stored under the SAME id Alice's row has.
    const firstId = first.ok ? first.id : "";
    const bRead = await readMessage(bob, { id: firstId });
    assert.ok(bRead.ok && bRead.body === "hey team");
    assert.equal(bRead.ok && bRead.group?.id, g1?.id);

    // Bob replies → the WHOLE group hears it, threaded on the shared mid.
    const reply = await sendMessage(bob, { in_reply_to: firstId, body: "count me in" });
    assert.ok(reply.ok && reply.group);
    assert.equal(reply.ok && reply.group?.id, g1?.id);

    const aBack = await readMessage(alice, {});
    assert.ok(aBack.ok && aBack.body === "count me in");
    assert.equal(aBack.ok && aBack.in_reply_to, firstId);
    assert.equal(aBack.ok && aBack.group?.id, g1?.id);

    // FALSE-NEGATIVE check: Carol has never met Bob, but Bob is in the stored
    // roster of a group Carol is in — his message flows, NOT held at the gate.
    const cAvail = await messagesAvailable(carol);
    assert.equal(cAvail.count, 3); // Alice ×2 + Bob's reply
    assert.equal(cAvail.new_handles, undefined, "a vouched member must not be held");
    const savedBob = contactByKey(carol.book, bId.signPub);
    assert.ok(savedBob, "the vouched member is auto-saved");
    assert.equal(savedBob?.gated, undefined);
  });

  test("group traffic never bleeds into 1:1 threads (and group history resolves by name)", async () => {
    const { alice } = await trio();
    const gsend = await sendMessage(alice, { to: "Bob, Carol", body: "group hello" });
    assert.ok(gsend.ok && gsend.group);
    const direct = await sendMessage(alice, { to: "Bob", body: "just for you" });
    assert.ok(direct.ok);

    // 1:1 history with Bob: ONLY the private message.
    const h1 = await messageHistory(alice, { with: "Bob" });
    assert.ok(h1.ok);
    assert.deepEqual(h1.ok ? h1.messages.map((m) => m.body) : [], ["just for you"]);

    // The group's thread, addressed by the group's name.
    const gname = gsend.ok && gsend.group ? gsend.group.name : "";
    const h2 = await messageHistory(alice, { with: gname });
    assert.ok(h2.ok);
    assert.equal(h2.ok && h2.with, gname);
    assert.deepEqual(h2.ok ? h2.messages.map((m) => m.body) : [], ["group hello"]);

    // A group name in `to` addresses the group.
    const byName = await sendMessage(alice, { to: gname, body: "again" });
    assert.ok(byName.ok && byName.group);
  });

  test("a single distinct recipient after dedupe stays a plain 1:1 send", async () => {
    const { alice } = await trio();
    const r = await sendMessage(alice, { to: "Bob, Bob", body: "hi" });
    assert.ok(r.ok);
    assert.equal(r.ok && r.group, undefined);
    assert.equal(r.ok && r.to.name, "Bob");
    assert.equal(alice.book.groups?.length ?? 0, 0);
  });

  test("an unknown name in the list fails the whole send with that name", async () => {
    const { alice } = await trio();
    const r = await sendMessage(alice, { to: "Bob, Nobody", body: "hi" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "no_contact");
    assert.equal(!r.ok && "query" in r ? r.query : "", "Nobody");
    assert.equal(alice.book.groups?.length ?? 0, 0, "no group is created on a failed resolve");
  });
});

describe("the gate: forged group claims (false positives)", () => {
  // Hand-seal a wire message to `to` with an arbitrary envelope — the path a
  // hostile client takes.
  async function sendForged(
    from: NetContext,
    to: { signPub: string; boxPub: string },
    text: string,
    group: WireGroup,
  ) {
    await from.client.send({
      id: randomUUID(),
      recipient: to.signPub,
      sender: from.me.signPub,
      body: seal(packBody(from.me, text, { group }), to.boxPub),
      tags: null,
      created_at: now(),
      in_reply_to: null,
    });
  }

  test("a stranger claiming a REAL group id is held, and the roster is untouched", async () => {
    const { alice, bob, bId } = await trio();
    await sendMessage(alice, { to: "Bob, Carol", body: "hello" });
    await sync(bob);
    const bobGroup = bob.book.groups![0]!;
    const before = bobGroup.members.map((m) => m.signPub).sort();

    const mId = generateIdentity();
    const mallory = makeContext(mb.baseUrl, mId);
    // Mallory somehow learned the group id and asserts a roster that includes
    // herself (and Bob) — the claim must vouch for nothing.
    await sendForged(mallory, { signPub: bId.signPub, boxPub: bId.boxPub }, "let me in", {
      id: bobGroup.id,
      name: "totally the same group",
      mid: randomUUID(),
      roster: [
        { name: "Mallory", signPub: mId.signPub, boxPub: mId.boxPub },
        { signPub: bId.signPub, boxPub: bId.boxPub },
      ],
    });

    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 1, "only Alice's real message surfaces");
    assert.equal(avail.new_handles?.length, 1, "the forger is held behind the gate");
    assert.equal(contactByKey(bob.book, mId.signPub)?.gated, "pending");
    // The stored group is exactly what it was: same name, same members.
    const after = groupById(bob.book, bobGroup.id)!;
    assert.deepEqual(after.members.map((m) => m.signPub).sort(), before);
    assert.notEqual(after.name, "totally the same group");
  });

  test("a stranger with an invented group id is held like any stranger", async () => {
    const { bob, bId } = await trio();
    const mId = generateIdentity();
    const mallory = makeContext(mb.baseUrl, mId);
    await sendForged(mallory, { signPub: bId.signPub, boxPub: bId.boxPub }, "psst", {
      id: "g" + "f".repeat(16),
      name: "fake",
      mid: randomUUID(),
      roster: [
        { name: "Mallory", signPub: mId.signPub, boxPub: mId.boxPub },
        { signPub: bId.signPub, boxPub: bId.boxPub },
      ],
    });
    const avail = await messagesAvailable(bob);
    assert.equal(avail.count, 0);
    assert.equal(avail.new_handles?.length, 1);
    assert.equal(groupById(bob.book, "g" + "f".repeat(16)), undefined, "no group is learned from a held sender");
  });

  test("a KNOWN contact's group message does teach the group (the sanctioned path)", async () => {
    const { alice, bob } = await trio();
    await sendMessage(alice, { to: "Bob, Carol", body: "real" });
    await sync(bob);
    assert.equal(bob.book.groups?.length, 1);
  });
});

describe("the group tool: create / rename / add / remove / leave", () => {
  test("named create opens the thread for every member", async () => {
    const { alice, bob, carol } = await trio();
    const r = await createGroup(alice, { members: ["Bob", "Carol"], name: "project-x", body: "kickoff" });
    assert.ok(r.ok && r.action === "create");
    assert.equal(r.ok && "group" in r ? r.group.name : "", "project-x");

    const bAvail = await messagesAvailable(bob);
    assert.equal(bAvail.count, 1);
    assert.equal(bAvail.messages[0]?.preview, "kickoff");
    assert.equal(bAvail.messages[0]?.group, "project-x");
    assert.ok(groupById(carol.book, "nope") === undefined); // sanity: no cross-talk
    await sync(carol);
    assert.equal(carol.book.groups?.[0]?.name, "project-x");
  });

  test("rename propagates; remove notifies the removed member and flips them to left", async () => {
    const { alice, bob, carol, cId } = await trio();
    await createGroup(alice, { members: ["Bob", "Carol"], name: "project-x" });
    await sync(bob);
    await sync(carol);

    const ren = await manageGroup(alice, { group: "project-x", action: "rename", name: "project-y" });
    assert.ok(ren.ok);
    await sync(bob);
    assert.equal(bob.book.groups?.[0]?.name, "project-y");

    const rem = await manageGroup(alice, { group: "project-y", action: "remove", name: "Carol" });
    assert.ok(rem.ok);
    assert.equal(groupById(alice.book, alice.book.groups![0]!.id)?.members.some((m) => m.signPub === cId.signPub), false);
    // Carol hears the final notice (from Alice, a known contact) and her copy
    // flips to left — sends are refused from then on.
    const cAvail = await messagesAvailable(carol);
    assert.ok(cAvail.messages.some((m) => m.preview.includes("removed")));
    assert.equal(carol.book.groups?.[0]?.left, true);
    const refused = await sendMessage(carol, { to: "project-y", body: "wait" });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "left_group");
    // Bob's roster shrinks to Alice only.
    await sync(bob);
    assert.equal(bob.book.groups?.[0]?.members.length, 1);
  });

  test("leave announces, keeps history readable, refuses new sends", async () => {
    const { alice, bob } = await trio();
    await createGroup(alice, { members: ["Bob", "Carol"], name: "standup" });
    await sync(bob);
    const left = await manageGroup(bob, { group: "standup", action: "leave" });
    assert.ok(left.ok && left.action === "leave");
    // Alice hears it and her roster drops Bob.
    const aAvail = await messagesAvailable(alice);
    assert.ok(aAvail.messages.some((m) => m.preview.includes("left the group")));
    assert.equal(alice.book.groups?.[0]?.members.length, 1);
    // Bob's local thread survives, but sending is refused.
    const h = await messageHistory(bob, { with: "standup" });
    assert.ok(h.ok && h.messages.length >= 1);
    const refused = await sendMessage(bob, { to: "standup", body: "one more" });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "left_group");
    // Leaving again is a no-op, not an error.
    const again = await manageGroup(bob, { group: "standup", action: "leave" });
    assert.ok(again.ok && again.action === "leave" && "already" in again && again.already === true);
  });

  test("add brings a newcomer in with the full roster; everyone learns them", async () => {
    const { alice, bob } = await trio();
    const dId = generateIdentity();
    const dave = makeContext(mb.baseUrl, dId, [
      { name: "Alice", signPub: alice.me.signPub, boxPub: alice.me.boxPub },
    ]);
    await regSelf(dave);
    alice.book.contacts.push({ name: "Dave", signPub: dId.signPub, boxPub: dId.boxPub });

    await createGroup(alice, { members: ["Bob", "Carol"], name: "ship-it" });
    const add = await manageGroup(alice, { group: "ship-it", action: "add", name: "Dave" });
    assert.ok(add.ok);
    // Dave (who only knows Alice) receives the announcement and the whole group.
    await sync(dave);
    const dg = dave.book.groups?.[0];
    assert.equal(dg?.name, "ship-it");
    assert.equal(dg?.members.length, 3); // Alice, Bob, Carol
    // Bob's roster now includes Dave.
    await sync(bob);
    assert.equal(bob.book.groups?.[0]?.members.length, 3);
    // Double-add is refused.
    const dup = await manageGroup(alice, { group: "ship-it", action: "add", name: "Dave" });
    assert.equal(dup.ok, false);
    assert.equal(!dup.ok && dup.reason, "already_member");
  });

  test("list shows groups with members and left flags", async () => {
    const { alice } = await trio();
    await createGroup(alice, { members: ["Bob"], name: "duo" });
    const l = listGroups(alice);
    assert.ok(l.ok && l.action === "list");
    assert.equal(l.groups.length, 1);
    assert.equal(l.groups[0]?.name, "duo");
    assert.deepEqual(l.groups[0]?.members, ["Bob"]);
  });
});
