// Shared test scaffolding. Spins up the real Hono mailbox in-process (on a
// random port, backed by a temp SQLite file) and builds NetContexts wired to
// it — the exact path the MCP server uses, minus the stdio transport. Crypto is
// initialised once per process; node:test isolates each test file in its own
// process, so every file that imports this gets a clean slate.

import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server-mailbox/app.ts";
import { nodeSqliteStore, type Store } from "../server-mailbox/store.ts";
import { initCrypto, generateIdentity, type Identity } from "../src/crypto.ts";
import { openMailbox } from "../src/db.ts";
import { createMailboxClient } from "../src/mailbox-client.ts";
import type { Contact, ContactBook } from "../src/contacts.ts";
import type { NetContext } from "../src/core-net.ts";

// A fixed wall clock keeps request-auth skew at zero and makes timestamps
// deterministic. Tests that care about ordering pass explicit created_at values.
export const FIXED_NOW = 1_700_000_000_000;
export const now = () => FIXED_NOW;

export interface Mailbox {
  baseUrl: string;
  store: Store;
  dbPath: string;
  close(): void;
}

// Boot the hosted mailbox on a real loopback port. Caller must close() it.
export async function startMailbox(clock: () => number = now): Promise<Mailbox> {
  await initCrypto();
  const dir = mkdtempSync(join(tmpdir(), "clim-test-"));
  const dbPath = join(dir, "mailbox.db");
  const store = nodeSqliteStore(dbPath);
  const app = createApp({ store, now: clock });
  const srv = await new Promise<any>((res) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => res(s));
  });
  const baseUrl = `http://localhost:${srv.address().port}`;
  return {
    baseUrl,
    store,
    dbPath,
    close() {
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function publicOf(id: Identity): Contact {
  return { id: "", name: "", signPub: id.signPub, boxPub: id.boxPub };
}

// Build a NetContext for `me`, knowing the given contacts, talking to `baseUrl`.
export function makeContext(
  baseUrl: string,
  me: Identity,
  contacts: Contact[] = [],
  clock: () => number = now,
): NetContext {
  const book: ContactBook = { me: me.signPub, contacts };
  return {
    me,
    book,
    cache: openMailbox(":memory:"),
    client: createMailboxClient(baseUrl, me, clock),
    now: clock,
  };
}

// Claim a handle for ctx.me, the way a real account does at setup. The mailbox
// now rejects mail to never-registered keys, so fixtures that receive must do
// this. The handle is derived from the key so repeated calls don't collide.
export async function regSelf(ctx: NetContext): Promise<void> {
  await ctx.client.registerHandle(ctx.me.signPub.slice(0, 6));
}

// Convenience: two mutual contacts on the same mailbox, each with the other in
// their book under a display name. Both are registered (real accounts always
// are), so either can receive mail.
export async function twoUsers(
  baseUrl: string,
  aName = "Alice",
  bName = "Bob",
): Promise<{ a: NetContext; b: NetContext; aId: Identity; bId: Identity }> {
  await initCrypto();
  const aId = generateIdentity();
  const bId = generateIdentity();
  const a = makeContext(baseUrl, aId, [
    { id: bName.toLowerCase(), name: bName, signPub: bId.signPub, boxPub: bId.boxPub },
  ]);
  const b = makeContext(baseUrl, bId, [
    { id: aName.toLowerCase(), name: aName, signPub: aId.signPub, boxPub: aId.boxPub },
  ]);
  await regSelf(a);
  await regSelf(b);
  return { a, b, aId, bId };
}
