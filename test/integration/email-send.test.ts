// Send by email (EMAIL-SEND.md) end to end through the real stack: core-net
// sendMessage → signed HTTP client → Hono mailbox → SQLite store. Covers the
// provision-on-demand resolve, the once-EVER invite rule, delivery to bound
// accounts, requests-only refusal, the claim (register-with-stub-keys) path,
// the /auth/poll stub handoff, the provision cap, and the key purge that keeps
// the notified tombstone.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveFetch, type ServedFetch } from "../serve-fetch.ts";
import { createApp } from "../../server-mailbox/app.ts";
import { nodeSqliteStore, type Store } from "../../server-mailbox/store.ts";
import type { OutboundEmail } from "../../server-mailbox/email.ts";
import { initCrypto, generateIdentity, type Identity } from "../../src/crypto.ts";
import { createAccountClient } from "../../src/account-client.ts";
import { sendMessage, sync, type SendResult } from "../../src/core-net.ts";
import { makeContext, now, FIXED_NOW } from "../helpers.ts";
import type { NetContext } from "../../src/core-net.ts";

// Narrow a sendMessage result to the fresh-send success variant (the union also
// carries the reply shape, which has no `saved`/`email`).
function sentOk(r: Awaited<ReturnType<typeof sendMessage>>): Extract<SendResult, { ok: true }> {
  assert.ok(r.ok, `expected an ok send, got ${JSON.stringify(r)}`);
  return r as Extract<SendResult, { ok: true }>;
}

// Mailbox with an invite recorder standing in for the Resend sender, plus dev
// magic links so the login flow can run headless.
interface Box {
  baseUrl: string;
  store: Store;
  invites: OutboundEmail[];
  close(): void;
}

async function bootMailbox(limits?: { emailProvisionDaily?: number }): Promise<Box> {
  await initCrypto();
  const dir = mkdtempSync(join(tmpdir(), "clim-email-test-"));
  const store = nodeSqliteStore(join(dir, "mailbox.db"));
  const invites: OutboundEmail[] = [];
  const app = createApp({
    store,
    now,
    limits,
    exposeMagicLink: true,
    sendInviteEmail: async (m) => {
      invites.push(m);
    },
  });
  const srv: ServedFetch = await serveFetch(app.fetch);
  return {
    baseUrl: srv.url,
    store,
    invites,
    close() {
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A registered sender named `name` — email sends require a registered identity.
async function sender(baseUrl: string, name: string): Promise<NetContext> {
  const ctx = makeContext(baseUrl, generateIdentity());
  ctx.me.name = name;
  await ctx.client.registerHandle(ctx.me.signPub.slice(0, 6), name);
  return ctx;
}

let mb: Box;
before(async () => {
  mb = await bootMailbox();
});
after(() => mb.close());

describe("send to an address without an account", () => {
  test("provisions, saves the contact with the email, and invites exactly once", async () => {
    const alice = await sender(mb.baseUrl, "Alice Ant");

    const first = sentOk(await sendMessage(alice, { to: "Sam", email: "sam@example.com", body: "hey Sam" }));
    assert.equal(first.saved, true);
    assert.equal(first.email, "sam@example.com");

    // Contact saved under the nick, carrying the address (no handle yet).
    const saved = alice.book.contacts.find((c) => c.name === "Sam");
    assert.ok(saved);
    assert.equal(saved.email, "sam@example.com");
    assert.equal(saved.handle, undefined);

    // The one invite went out, fronted by the sender's name.
    assert.equal(mb.invites.length, 1);
    assert.equal(mb.invites[0]!.to, "sam@example.com");
    assert.match(mb.invites[0]!.subject, /Alice Ant/);

    // Later sends (same sender by name, ANOTHER sender by email) never re-invite.
    const second = sentOk(await sendMessage(alice, { to: "Sam", body: "me again" }));
    assert.ok(!second.saved);
    const carol = await sender(mb.baseUrl, "Carol");
    const fromCarol = sentOk(await sendMessage(carol, { to: "Sammy", email: "sam@example.com", body: "hi" }));
    assert.equal(fromCarol.saved, true);
    assert.equal(mb.invites.length, 1);

    // Both senders resolved the SAME provisional identity.
    assert.equal(saved.signPub, carol.book.contacts.find((c) => c.name === "Sammy")?.signPub);
  });

  test("the address itself can be the recipient name", async () => {
    const dave = await sender(mb.baseUrl, "Dave");
    const r = sentOk(await sendMessage(dave, { to: "mette@example.com", body: "hej" }));
    assert.equal(r.saved, true);
    // Named from the mailbox-local part, address kept on the contact.
    const c = dave.book.contacts.find((x) => x.email === "mette@example.com");
    assert.equal(c?.name, "mette");
  });

  test("an unregistered sender cannot resolve emails", async () => {
    const ghost = makeContext(mb.baseUrl, generateIdentity());
    await assert.rejects(
      () => sendMessage(ghost, { to: "X", email: "target@example.com", body: "hi" }),
      /403/,
    );
  });
});

describe("claiming the waiting account", () => {
  test("login hands over the stub; registering a handle claims it and the mail is there", async () => {
    const alice = await sender(mb.baseUrl, "Alice Ant");
    await sendMessage(alice, { to: "Nils", email: "nils@example.com", body: "welcome aboard" });

    // The login flow (dev links) reaches "ready" with the stub keys attached.
    const account = createAccountClient(mb.baseUrl);
    const start = await account.startLogin("nils@example.com");
    await fetch(start.devLink!);
    const ready = await account.poll(start.poll_id);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") throw new Error("unreachable");
    const stub = ready.account.stub;
    assert.ok(stub, "poll should hand over the provisional identity");

    // Setup adopts the stub keys and claims a handle — the server then drops its
    // copies of the private halves (register-is-claim).
    const id: Identity = { ...stub!, name: "Nils" };
    const nils = makeContext(mb.baseUrl, id);
    await nils.client.registerHandle("Nils01", "Nils");
    const row = await mb.store.getEmailStub("nils@example.com");
    assert.equal(row?.signSec, null);
    assert.equal(row?.boxSec, null);
    assert.equal(row?.signPub, stub!.signPub); // publics stay (email → identity map)

    // The waiting message drains like any mail; the sender is a first-time
    // sender, so the gate holds them as usual.
    const added = await sync(nils);
    assert.equal(added, 1);
    const held = nils.book.contacts.find((c) => c.signPub === alice.me.signPub);
    assert.equal(held?.gated, "pending");
  });

  test("the sender's contact backfills the handle once the owner claims and replies", async () => {
    const alice = await sender(mb.baseUrl, "Alice Ant");
    await sendMessage(alice, { to: "Freja", email: "freja@example.com", body: "hi Freja" });

    // Freja claims the stub and finishes setup with a handle, like login does.
    const account = createAccountClient(mb.baseUrl);
    const start = await account.startLogin("freja@example.com");
    await fetch(start.devLink!);
    const ready = await account.poll(start.poll_id);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") throw new Error("unreachable");
    const freja = makeContext(mb.baseUrl, { ...ready.account.stub!, name: "Freja", handle: "Freja1" });
    await freja.client.registerHandle("Freja1", "Freja");
    await sync(freja);

    // Her reply (which accepts Alice through the gate) carries the new handle;
    // Alice's sync backfills it onto the email-saved contact — the address stays.
    sentOk(await sendMessage(freja, { to: "Alice", body: "got it!" }));
    assert.equal(await sync(alice), 1);
    const c = alice.book.contacts.find((x) => x.email === "freja@example.com");
    assert.ok(c, "the email-saved contact should still be there");
    assert.equal(c.name, "Freja"); // the sender's nick is untouched
    assert.equal(c.handle, "Freja1"); // handle backfilled from her envelope
    assert.equal(c.email, "freja@example.com"); // address kept alongside
  });
});

describe("addresses with a bound account", () => {
  test("deliver to the account's real identity — no stub, no invite", async () => {
    const bob = await sender(mb.baseUrl, "Bob");
    const acc = await mb.store.getOrCreateAccount("bob@example.com", FIXED_NOW);
    await mb.store.bindAccountSignPub(acc.id, bob.me.signPub, FIXED_NOW);

    const invitesBefore = mb.invites.length;
    const alice = await sender(mb.baseUrl, "Alice Ant");
    const r = sentOk(await sendMessage(alice, { to: "Bob", email: "bob@example.com", body: "ping" }));
    assert.equal(r.saved, true);
    assert.equal(r.to.signPub, bob.me.signPub);
    assert.equal(mb.invites.length, invitesBefore);
    assert.equal(await mb.store.getEmailStub("bob@example.com"), null);

    assert.equal(await sync(bob), 1);
  });

  test("requests-only closes the email path (email_unreachable)", async () => {
    const rina = await sender(mb.baseUrl, "Rina");
    const acc = await mb.store.getOrCreateAccount("rina@example.com", FIXED_NOW);
    await mb.store.bindAccountSignPub(acc.id, rina.me.signPub, FIXED_NOW);
    await mb.store.setRequestsOnly(rina.me.signPub, true, FIXED_NOW);

    const alice = await sender(mb.baseUrl, "Alice Ant");
    const r = await sendMessage(alice, { to: "Rina", email: "rina@example.com", body: "hi" });
    assert.equal(r.ok === false && r.reason, "email_unreachable");
  });
});

describe("retention & caps", () => {
  test("the key purge keeps the once-ever tombstone; a re-key never re-invites", async () => {
    const alice = await sender(mb.baseUrl, "Alice Ant");
    await sendMessage(alice, { to: "Old", email: "old@example.com", body: "hello" });
    const invitesAfterFirst = mb.invites.length;

    // Age the stub past the cutoff and drain its mail so the purge may take it.
    const stubIdentity = await mb.store.getEmailStub("old@example.com");
    await mb.store.drain(stubIdentity!.signPub!, FIXED_NOW);
    const purged = await mb.store.purgeEmailStubs(FIXED_NOW + 1);
    assert.equal(purged, 1);
    const row = await mb.store.getEmailStub("old@example.com");
    assert.equal(row?.signPub, null);
    assert.ok(row?.notifiedAt, "the once-ever marker survives the purge");

    // Writing the address again re-provisions fresh keys — and stays silent.
    const r = sentOk(await sendMessage(alice, { to: "Old2", email: "old@example.com", body: "again" }));
    assert.equal(r.saved, true);
    const rekeyed = await mb.store.getEmailStub("old@example.com");
    assert.ok(rekeyed?.signPub && rekeyed.signPub !== stubIdentity!.signPub);
    assert.equal(mb.invites.length, invitesAfterFirst);
  });

  test("a stub with mail still waiting is never purged", async () => {
    const alice = await sender(mb.baseUrl, "Alice Ant");
    await sendMessage(alice, { to: "Waiting", email: "waiting@example.com", body: "hold on" });
    assert.equal(await mb.store.purgeEmailStubs(FIXED_NOW + 1), 0);
    assert.ok((await mb.store.getEmailStub("waiting@example.com"))?.signPub);
  });

  test("the daily provision cap bounds distinct new addresses per sender", async () => {
    const box = await bootMailbox({ emailProvisionDaily: 2 });
    try {
      const spammer = await sender(box.baseUrl, "Spammy");
      await sendMessage(spammer, { to: "A", email: "a@example.com", body: "x" });
      await sendMessage(spammer, { to: "B", email: "b@example.com", body: "x" });
      await assert.rejects(
        () => sendMessage(spammer, { to: "C", email: "c@example.com", body: "x" }),
        /429/,
      );
      // Cap or not, only the two provisioned addresses were ever emailed.
      assert.equal(box.invites.length, 2);
    } finally {
      box.close();
    }
  });
});
