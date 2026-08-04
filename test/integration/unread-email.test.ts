// Waiting-mail email (NOTIFY-EMAIL.md) against the real store + Hono mailbox:
// the hourly sweep emails an account once per away-stretch when mail has sat
// unfetched for 24h, the drain route re-arms the marker, the opt-out route
// silences it, and non-users (email stubs) NEVER get a second email — the
// once-ever invite promise (EMAIL-SEND.md) holds.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveFetch, type ServedFetch } from "../serve-fetch.ts";
import { createApp } from "../../server-mailbox/app.ts";
import { nodeSqliteStore, type Store } from "../../server-mailbox/store.ts";
import { unreadEmail, type OutboundEmail } from "../../server-mailbox/email.ts";
import { sweepUnreadEmails, UNREAD_AGE_MS } from "../../server-mailbox/unread-sweep.ts";
import { initCrypto, generateIdentity } from "../../src/core/crypto.ts";
import { createMailboxClient } from "../../src/core/mailbox-client.ts";
import { now, FIXED_NOW } from "../helpers.ts";

// Sweep moment: past the 24h trigger for anything received at FIXED_NOW.
const LATER = FIXED_NOW + UNREAD_AGE_MS + 60_000;

// A store-level message row. The store never reads bodies, so a plain string
// stands in for the sealed blob; receivedAt is what the sweep keys on.
let msgSeq = 0;
function put(store: Store, recipient: string, sender: string, receivedAt = FIXED_NOW): Promise<void> | void {
  msgSeq++;
  return store.put(
    {
      id: `m${msgSeq}`,
      recipient,
      sender,
      body: "sealed",
      tags: null,
      created_at: receivedAt,
      in_reply_to: null,
    },
    receivedAt,
  );
}

// Bind an online account (email known server-side) to an identity key.
async function accountFor(store: Store, signPub: string, email: string): Promise<void> {
  const acc = await store.getOrCreateAccount(email, FIXED_NOW);
  await store.bindAccountSignPub(acc.id, signPub, FIXED_NOW);
}

function recorder(): { sent: OutboundEmail[]; send: (m: OutboundEmail) => Promise<void> } {
  const sent: OutboundEmail[] = [];
  return { sent, send: async (m) => void sent.push(m) };
}

function freshStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "clim-unread-test-"));
  const store = nodeSqliteStore(join(dir, "mailbox.db"));
  return { store, close: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the sweep (store-level)", () => {
  test("aged unfetched mail to a bound account → one email, once", async () => {
    const { store, close } = freshStore();
    try {
      await store.registerHandle("alice1", "alice-sign", "alice-box", FIXED_NOW, "Alice Ant");
      await accountFor(store, "bob-sign", "bob@example.com");
      await put(store, "bob-sign", "alice-sign");
      await put(store, "bob-sign", "alice-sign");

      const { sent, send } = recorder();
      assert.equal(await sweepUnreadEmails(store, send, LATER), 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, "bob@example.com");
      assert.match(sent[0]!.subject, /2 messages/);
      assert.match(sent[0]!.text, /Alice Ant/);
      assert.ok(!sent[0]!.text.includes("sealed"), "bodies never appear");

      // Marker set: the very next sweep is silent, even as more mail ages.
      await put(store, "bob-sign", "alice-sign");
      assert.equal(await sweepUnreadEmails(store, send, LATER + UNREAD_AGE_MS), 0);
      assert.equal(sent.length, 1);
    } finally {
      close();
    }
  });

  test("mail younger than 24h does not trigger", async () => {
    const { store, close } = freshStore();
    try {
      await accountFor(store, "bob-sign", "bob@example.com");
      await put(store, "bob-sign", "alice-sign", LATER - 60_000); // 1 min before the sweep
      const { sent, send } = recorder();
      assert.equal(await sweepUnreadEmails(store, send, LATER), 0);
      assert.equal(sent.length, 0);
    } finally {
      close();
    }
  });

  test("a registered handle with no account has no email to send to", async () => {
    const { store, close } = freshStore();
    try {
      await store.registerHandle("carol1", "carol-sign", "carol-box", FIXED_NOW, "Carol");
      await put(store, "carol-sign", "alice-sign");
      const { sent, send } = recorder();
      assert.equal(await sweepUnreadEmails(store, send, LATER), 0);
      assert.equal(sent.length, 0);
    } finally {
      close();
    }
  });

  test("email stubs are excluded — the once-ever invite promise holds", async () => {
    const { store, close } = freshStore();
    try {
      // A written-to address that never joined: stub identity, mail waiting.
      await store.upsertEmailStub(
        "stranger@example.com",
        { signPub: "stub-sign", boxPub: "stub-box", signSec: "s", boxSec: "b" },
        "alice-sign",
        FIXED_NOW,
      );
      await store.markEmailNotified("stranger@example.com", FIXED_NOW); // the one invite
      await put(store, "stub-sign", "alice-sign");
      const { sent, send } = recorder();
      assert.equal(await sweepUnreadEmails(store, send, LATER), 0);
      assert.equal(sent.length, 0, "a non-user is never emailed twice");
    } finally {
      close();
    }
  });

  test("opt-out silences the sweep; opting back in re-enables it", async () => {
    const { store, close } = freshStore();
    try {
      await accountFor(store, "bob-sign", "bob@example.com");
      await put(store, "bob-sign", "alice-sign");
      await store.setUnreadEmails("bob-sign", false, FIXED_NOW);
      const { sent, send } = recorder();
      assert.equal(await sweepUnreadEmails(store, send, LATER), 0);
      await store.setUnreadEmails("bob-sign", true, FIXED_NOW);
      assert.equal(await sweepUnreadEmails(store, send, LATER), 1);
      assert.equal(sent.length, 1);
    } finally {
      close();
    }
  });

  test("self-mail neither triggers nor is counted or named", async () => {
    const { store, close } = freshStore();
    try {
      await store.registerHandle("bob123", "bob-sign", "bob-box", FIXED_NOW, "Bob");
      await accountFor(store, "bob-sign", "bob@example.com");
      await put(store, "bob-sign", "bob-sign"); // note to self
      const { sent, send } = recorder();
      assert.equal(await sweepUnreadEmails(store, send, LATER), 0);

      // With a real message alongside, the self-send doesn't inflate the count.
      await put(store, "bob-sign", "alice-sign");
      assert.equal(await sweepUnreadEmails(store, send, LATER + UNREAD_AGE_MS), 1);
      assert.match(sent[0]!.subject, /1 message\b/);
      assert.ok(!sent[0]!.text.includes("Bob"), "the user is not a sender in their own email");
    } finally {
      close();
    }
  });

  test("the per-run cap defers, never drops", async () => {
    const { store, close } = freshStore();
    try {
      for (let i = 0; i < 3; i++) {
        await accountFor(store, `u${i}-sign`, `u${i}@example.com`);
        await put(store, `u${i}-sign`, "alice-sign");
      }
      const { sent, send } = recorder();
      assert.equal(await sweepUnreadEmails(store, send, LATER, { max: 2 }), 2);
      // The overflow candidate qualifies on the next run.
      assert.equal(await sweepUnreadEmails(store, send, LATER, { max: 2 }), 1);
      assert.equal(new Set(sent.map((m) => m.to)).size, 3);
    } finally {
      close();
    }
  });

  test("a failed send leaves the marker unset and retries next run", async () => {
    const { store, close } = freshStore();
    try {
      await accountFor(store, "bob-sign", "bob@example.com");
      await put(store, "bob-sign", "alice-sign");
      let calls = 0;
      const flaky = async () => {
        calls++;
        if (calls === 1) throw new Error("resend down");
      };
      assert.equal(await sweepUnreadEmails(store, flaky, LATER), 0);
      assert.equal(await sweepUnreadEmails(store, flaky, LATER), 1);
      assert.equal(calls, 2);
    } finally {
      close();
    }
  });
});

describe("away-stretch cycle through the real mailbox (drain re-arms)", () => {
  let dir: string;
  let store: Store;
  let srv: ServedFetch;

  before(async () => {
    await initCrypto();
    dir = mkdtempSync(join(tmpdir(), "clim-unread-app-"));
    store = nodeSqliteStore(join(dir, "mailbox.db"));
    srv = await serveFetch(createApp({ store, now }).fetch);
  });
  after(() => {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("email → silence while away → drain → new mail → second email", async () => {
    const bob = generateIdentity();
    const client = createMailboxClient(srv.url, bob, now);
    await client.registerHandle("bobbbb", "Bob");
    await accountFor(store, bob.signPub, "bob@example.com");
    await put(store, bob.signPub, "alice-sign");

    const { sent, send } = recorder();
    assert.equal(await sweepUnreadEmails(store, send, LATER), 1);
    assert.equal(await sweepUnreadEmails(store, send, LATER), 0, "still away → no second email");

    // Bob comes online: the signed GET /messages drain re-arms the marker.
    const drained = await client.drain();
    assert.equal(drained.length, 1);

    // Nothing waiting → quiet; a NEW away-stretch with aged mail emails again.
    assert.equal(await sweepUnreadEmails(store, send, LATER + UNREAD_AGE_MS), 0);
    await put(store, bob.signPub, "alice-sign", LATER);
    assert.equal(await sweepUnreadEmails(store, send, LATER + UNREAD_AGE_MS + 60_000), 1);
    assert.equal(sent.length, 2);
  });

  test("the opt-out route flips the account flag over signed HTTP", async () => {
    const rina = generateIdentity();
    const client = createMailboxClient(srv.url, rina, now);
    await client.registerHandle("rinaaa", "Rina");
    await accountFor(store, rina.signPub, "rina@example.com");
    await put(store, rina.signPub, "alice-sign");

    await client.setUnreadEmails(false);
    const { sent, send } = recorder();
    assert.equal(await sweepUnreadEmails(store, send, LATER), 0);
    await client.setUnreadEmails(true);
    assert.equal(await sweepUnreadEmails(store, send, LATER), 1);
    assert.equal(sent[0]!.to, "rina@example.com");
  });
});

describe("the email itself", () => {
  test("a hostile sender name is HTML-escaped, plain in text", () => {
    const m = unreadEmail("x@example.com", { count: 1, senderNames: ['<script>alert(1)</script>'] });
    assert.ok(!m.html.includes("<script>"));
    assert.ok(m.text.includes("<script>alert(1)</script>"), "text part carries the raw name");
  });

  test("subject: single named sender vs counts; names deduped and capped", () => {
    const one = unreadEmail("x@example.com", { count: 1, senderNames: ["Niels"] });
    assert.equal(one.subject, "Niels is waiting on you on cli-chat");
    const many = unreadEmail("x@example.com", {
      count: 7,
      senderNames: ["A", "A", "B", "C", "D", null, ""],
    });
    assert.equal(many.subject, "You have 7 messages waiting on cli-chat");
    assert.match(many.text, /from A, B, C and 1 other\b/);
  });

  test("nameless senders still make a sendable email", () => {
    const m = unreadEmail("x@example.com", { count: 2, senderNames: [null, null] });
    assert.match(m.subject, /2 messages waiting/);
    assert.match(m.text, /2 unread messages waiting/);
  });
});
