// Phase 1 tool operations: encrypted + networked. Sending seals the body to the
// recipient and POSTs the blob to the hosted mailbox. Receiving drains blobs
// from the mailbox, decrypts them locally, and caches the plaintext in a
// per-user inbox DB — so read_message / previews keep their Phase 0 feel while
// the server only ever holds ciphertext.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { getMessage, insertMessage, markRead, unreadFor, type MessageRow, type Mailbox } from "./db.ts";
import {
  contactByKey,
  saveContacts,
  senderLabel,
  resolve,
  type Contact,
  type ContactBook,
} from "./contacts.ts";
import { open, seal, type Identity } from "./crypto.ts";
import { isHandle, parseKey } from "./key-code.ts";
import type { MailboxClient } from "./mailbox-client.ts";
import type { WireMessage } from "./identity.ts";

export interface NetContext {
  me: Identity;
  book: ContactBook;
  cache: Mailbox; // local decrypted inbox
  client: MailboxClient; // hosted mailbox
  now: () => number;
  contactsPath?: string; // where to persist the book when a contact is added
}

// Save (or update) a contact in the book and persist it to disk if we know
// where the book lives. Replaces any entry with the same local name or key.
// `auto` marks a contact saved from a received self-introduction (their own name,
// not a nick you chose); a manual save/rename leaves it off so the nick wins.
export function rememberContact(
  ctx: NetContext,
  c: { name: string; signPub: string; boxPub: string; handle?: string; auto?: boolean },
): void {
  const id = c.name.toLowerCase();
  ctx.book.contacts = ctx.book.contacts.filter(
    (x) => x.id !== id && x.signPub !== c.signPub,
  );
  const entry: Contact = { id, name: c.name, signPub: c.signPub, boxPub: c.boxPub };
  if (c.handle) entry.handle = c.handle;
  if (c.auto) entry.auto = true;
  ctx.book.contacts.push(entry);
  if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
}

// A message body packs a small self-introduction alongside the text, sealed to
// the recipient so only they (not the mailbox) can read it: who sent it (their
// chosen name + 6-char handle) and the X25519 key to reply to. This is what lets
// a recipient SEE who an unknown sender is and reply without a prior contact.
const ENVELOPE_V = 1;

export function packBody(me: Identity, text: string): string {
  const env: { v: number; text: string; name?: string; handle?: string; boxPub: string } = {
    v: ENVELOPE_V,
    text,
    boxPub: me.boxPub, // reply key — lets a stranger be answered + auto-saved
  };
  if (me.name) env.name = me.name;
  if (me.handle) env.handle = me.handle;
  return JSON.stringify(env);
}

export interface Unpacked {
  text: string;
  name?: string;
  handle?: string;
  boxPub?: string;
}

// Inverse of packBody. Legacy/plain bodies aren't our JSON envelope, so they pass
// through as plain text with no metadata — full back-compat with messages sent
// before this existed.
export function unpackBody(plaintext: string): Unpacked {
  try {
    const o = JSON.parse(plaintext) as Record<string, unknown>;
    if (o && typeof o === "object" && o.v === ENVELOPE_V && typeof o.text === "string") {
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      return { text: o.text, name: str(o.name), handle: str(o.handle), boxPub: str(o.boxPub) };
    }
  } catch {
    /* not our envelope — treat as a plain legacy body */
  }
  return { text: plaintext };
}

// Resolve a shared code — either a 6-char handle (looked up in the server
// registry) or a long full key code — to a pair of public keys. When the code
// itself was a handle, return it so we can save it on the contact.
async function resolveCode(
  ctx: NetContext,
  code: string,
): Promise<{ signPub: string; boxPub: string; handle?: string } | null> {
  const full = parseKey(code);
  if (full) return full;
  if (isHandle(code)) {
    const keys = await ctx.client.resolveHandle(code.trim());
    return keys ? { ...keys, handle: code.trim() } : null;
  }
  return null;
}

export type AddContactResult =
  | { ok: true; name: string }
  | { ok: false; reason: "bad_key" | "not_found" };

// Add a contact from a shared code (handle or full key) — conversational onboarding.
export async function addContact(
  ctx: NetContext,
  args: { name: string; key: string },
): Promise<AddContactResult> {
  if (!parseKey(args.key) && !isHandle(args.key)) return { ok: false, reason: "bad_key" };
  const keys = await resolveCode(ctx, args.key);
  if (!keys) return { ok: false, reason: "not_found" };
  rememberContact(ctx, { name: args.name, signPub: keys.signPub, boxPub: keys.boxPub, handle: keys.handle });
  return { ok: true, name: args.name };
}

// Pull any waiting blobs, decrypt, and store in the local cache. Idempotent:
// the server marks blobs fetched on drain, and we guard on id locally too.
export async function sync(ctx: NetContext): Promise<number> {
  const blobs = await ctx.client.drain();
  let added = 0;
  for (const b of blobs) {
    if (getMessage(ctx.cache, b.id)) continue;
    let plain: string;
    try {
      plain = open(b.body, ctx.me.boxPub, ctx.me.boxSec);
    } catch {
      // Undecryptable for us (sealed to a different identity / wrong key). A sealed
      // box never becomes readable later, so don't cache it as a phantom message
      // that would surface to the user as content — skip it. (The server already
      // marked it fetched on drain, so it won't be re-pulled.)
      console.error(`sync: skipping a blob that won't decrypt (id ${b.id}).`);
      continue;
    }
    // Split the text from the sender's self-introduction. Only the text is cached;
    // the identity feeds the contact book.
    const env = unpackBody(plain);
    // Auto-save a genuinely new sender from the keys they introduced themselves
    // with, so "write <name>" works next time and a reply can be sealed. NEVER
    // clobber someone you already know — your nick for them wins.
    const known = b.sender ? contactByKey(ctx.book, b.sender) : undefined;
    if (env.boxPub && b.sender && !known) {
      const name = env.name || env.handle || `${b.sender.slice(0, 8)}…`;
      rememberContact(ctx, {
        name,
        signPub: b.sender,
        boxPub: env.boxPub,
        handle: env.handle,
        auto: true,
      });
    } else if (known && env.handle && !known.handle) {
      // Known contact missing a handle (e.g. saved before self-introductions
      // existed). Backfill ONLY the handle from their new-style envelope —
      // never touch name/nick/auto, so "your nick wins" still holds.
      known.handle = env.handle;
      if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
    }
    const row: MessageRow = {
      id: b.id,
      recipient: ctx.me.signPub,
      sender: b.sender,
      body: env.text,
      tags: b.tags,
      created_at: b.created_at,
      fetched_at: ctx.now(),
      read_at: null,
      in_reply_to: b.in_reply_to,
    };
    insertMessage(ctx.cache, row);
    added++;
  }
  return added;
}

export type SendResult =
  | { ok: true; id: string; to: { name: string; signPub: string }; saved?: boolean }
  | {
      ok: false;
      reason: "no_contact" | "ambiguous" | "no_keys" | "bad_key";
      query: string;
      candidates?: string[];
    };

async function sendSealed(
  ctx: NetContext,
  to: { name: string; signPub: string; boxPub: string },
  body: string,
  in_reply_to: string | null,
): Promise<string> {
  const wire: WireMessage = {
    id: randomUUID(),
    recipient: to.signPub,
    sender: ctx.me.signPub,
    body: seal(packBody(ctx.me, body), to.boxPub),
    tags: null,
    created_at: ctx.now(),
    in_reply_to,
  };
  await ctx.client.send(wire);
  return wire.id;
}

// Send to a known contact by name, OR to a brand-new person via their key code
// (in which case we save them as a contact named `to` for next time).
export async function sendMessage(
  ctx: NetContext,
  args: { to: string; body: string; key?: string },
): Promise<SendResult> {
  const r = resolve(ctx.book, args.to);

  if (r.status === "none") {
    // No such contact. If the user supplied a key code or handle, resolve it,
    // remember them under the name they gave, and send.
    if (args.key) {
      if (!parseKey(args.key) && !isHandle(args.key))
        return { ok: false, reason: "bad_key", query: args.to };
      const keys = await resolveCode(ctx, args.key);
      if (!keys) return { ok: false, reason: "bad_key", query: args.to };
      rememberContact(ctx, { name: args.to, signPub: keys.signPub, boxPub: keys.boxPub, handle: keys.handle });
      const id = await sendSealed(ctx, { name: args.to, ...keys }, args.body, null);
      return { ok: true, id, to: { name: args.to, signPub: keys.signPub }, saved: true };
    }
    return { ok: false, reason: "no_contact", query: args.to };
  }
  if (r.status === "ambiguous")
    return {
      ok: false,
      reason: "ambiguous",
      query: args.to,
      candidates: r.candidates.map((c) => c.name),
    };
  const c = r.contact;
  if (!c.signPub || !c.boxPub)
    return { ok: false, reason: "no_keys", query: args.to };

  const id = await sendSealed(ctx, { name: c.name, signPub: c.signPub, boxPub: c.boxPub }, args.body, null);
  return { ok: true, id, to: { name: c.name, signPub: c.signPub } };
}

export interface InboxMessage {
  id: string;
  from: string;
  body: string;
  at: number;
  in_reply_to: string | null;
}

// Take every currently-unread message, marking each read, with the FULL body —
// the receive shape the live `watch` loop hands straight to the user. Kept here
// (not inlined in the watch tool) so it shares the sender-labelling and read
// semantics with the rest of the receive path instead of the tool reaching into
// the cache directly.
export function takeUnread(ctx: NetContext): InboxMessage[] {
  return unreadFor(ctx.cache, ctx.me.signPub).map((m) => {
    markRead(ctx.cache, m.id, ctx.now());
    return {
      id: m.id,
      from: senderLabel(ctx.book, m.sender),
      body: m.body,
      at: m.created_at,
      in_reply_to: m.in_reply_to,
    };
  });
}

// ---- pending snapshot: the warmer→hook channel (PUSH.md / db.ts cross-process) ----
// The session hook can't safely open inbox.db while the warmer holds it (the wasm
// driver's cross-process lock — the old "mail never surfaced" bug). So the warmer
// (sole writer) mirrors current unread mail here, already decrypted, and the hook
// just reads it. Read-state stays in SQLite; a message is marked read ONLY once the
// hook acks it (writePendingAck → refreshPending), never at queue time — so `watch`
// and messages_available aren't starved, and nothing is lost if the hook never runs.

export interface PendingSnapshot {
  writtenAt: number;
  messages: InboxMessage[];
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

// Hook side: the ids it has already surfaced (so it doesn't re-announce them in the
// window before the warmer applies the ack). Missing/corrupt file → none.
export function readAck(ackPath: string): string[] {
  try {
    const ids = JSON.parse(readFileSync(ackPath, "utf8"));
    return Array.isArray(ids) ? (ids as string[]) : [];
  } catch {
    return [];
  }
}

// Hook side: read the warmer's snapshot (null when absent/corrupt → fall back to a
// direct drain, which is safe precisely because no warmer is holding the file).
export function readPending(pendingPath: string): PendingSnapshot | null {
  try {
    const snap = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingSnapshot;
    if (snap && Array.isArray(snap.messages) && typeof snap.writtenAt === "number") return snap;
  } catch {
    /* missing/corrupt — caller falls back */
  }
  return null;
}

// Hook side: record the ids surfaced this run (overwrite — always the current
// pending set, so it never grows unbounded). The warmer applies it on its next tick.
export function writePendingAck(ackPath: string, ids: string[]): void {
  writeJsonAtomic(ackPath, ids);
}

// Warmer side: apply any ids the hook acked (mark them read so they drop out), then
// mirror the remaining unread set to pendingPath. The ONLY writer of pendingPath.
export function refreshPending(ctx: NetContext, pendingPath: string, ackPath: string): void {
  for (const id of readAck(ackPath)) markRead(ctx.cache, id, ctx.now());
  const messages: InboxMessage[] = unreadFor(ctx.cache, ctx.me.signPub).map((m) => ({
    id: m.id,
    from: senderLabel(ctx.book, m.sender),
    body: m.body,
    at: m.created_at,
    in_reply_to: m.in_reply_to,
  }));
  writeJsonAtomic(pendingPath, { writtenAt: ctx.now(), messages } satisfies PendingSnapshot);
}

export interface AvailableResult {
  count: number;
  messages: { id: string; from: string; preview: string; at: number }[];
}

export async function messagesAvailable(ctx: NetContext): Promise<AvailableResult> {
  await sync(ctx);
  const rows = unreadFor(ctx.cache, ctx.me.signPub);
  return {
    count: rows.length,
    messages: rows.map((m) => ({
      id: m.id,
      from: senderLabel(ctx.book, m.sender),
      preview: m.body.length > 200 ? m.body.slice(0, 197) + "..." : m.body,
      at: m.created_at,
    })),
  };
}

export type ReadResult =
  | { ok: true; id: string; from: string; body: string; at: number; in_reply_to: string | null }
  | { ok: false; reason: "empty" | "not_found" };

export async function readMessage(ctx: NetContext, args: { id?: string }): Promise<ReadResult> {
  await sync(ctx);
  let row: MessageRow | undefined;
  if (args.id) {
    row = getMessage(ctx.cache, args.id);
    if (!row || row.recipient !== ctx.me.signPub) return { ok: false, reason: "not_found" };
  } else {
    row = unreadFor(ctx.cache, ctx.me.signPub)[0];
    if (!row) return { ok: false, reason: "empty" };
  }
  markRead(ctx.cache, row.id, ctx.now());
  return {
    ok: true,
    id: row.id,
    from: senderLabel(ctx.book, row.sender),
    body: row.body,
    at: row.created_at,
    in_reply_to: row.in_reply_to,
  };
}

export type ReplyResult =
  | { ok: true; id: string; to: { name: string; signPub: string } }
  | { ok: false; reason: "not_found" | "no_keys" };

export async function draftReply(
  ctx: NetContext,
  args: { in_reply_to: string; body: string },
): Promise<ReplyResult> {
  const original = getMessage(ctx.cache, args.in_reply_to);
  if (!original) return { ok: false, reason: "not_found" };

  const c = contactByKey(ctx.book, original.sender);
  if (!c || !c.signPub || !c.boxPub) return { ok: false, reason: "no_keys" };

  const id = await sendSealed(ctx, { name: c.name, signPub: c.signPub, boxPub: c.boxPub }, args.body, original.id);
  return { ok: true, id, to: { name: c.name, signPub: c.signPub } };
}
