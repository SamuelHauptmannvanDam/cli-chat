// Phase 1 tool operations: encrypted + networked. Sending seals the body to the
// recipient and POSTs the blob to the hosted mailbox. Receiving drains blobs
// from the mailbox, decrypts them locally, and caches the plaintext in a
// per-user inbox DB — so read_message / previews keep their Phase 0 feel while
// the server only ever holds ciphertext.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { getMessage, insertMessage, markRead, unreadFor, type MessageRow, type Mailbox } from "./db.ts";
import {
  contactByKey,
  displayNameByKey,
  resolve,
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
export function rememberContact(
  ctx: NetContext,
  c: { name: string; signPub: string; boxPub: string },
): void {
  const id = c.name.toLowerCase();
  ctx.book.contacts = ctx.book.contacts.filter(
    (x) => x.id !== id && x.signPub !== c.signPub,
  );
  ctx.book.contacts.push({ id, name: c.name, signPub: c.signPub, boxPub: c.boxPub });
  if (ctx.contactsPath) {
    writeFileSync(ctx.contactsPath, JSON.stringify(ctx.book, null, 2) + "\n");
  }
}

// Resolve a shared code — either a 6-char handle (looked up in the server
// registry) or a long full key code — to a pair of public keys.
async function resolveCode(
  ctx: NetContext,
  code: string,
): Promise<{ signPub: string; boxPub: string } | null> {
  const full = parseKey(code);
  if (full) return full;
  if (isHandle(code)) return await ctx.client.resolveHandle(code.trim());
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
  rememberContact(ctx, { name: args.name, signPub: keys.signPub, boxPub: keys.boxPub });
  return { ok: true, name: args.name };
}

// Pull any waiting blobs, decrypt, and store in the local cache. Idempotent:
// the server marks blobs fetched on drain, and we guard on id locally too.
export async function sync(ctx: NetContext): Promise<number> {
  const blobs = await ctx.client.drain();
  let added = 0;
  for (const b of blobs) {
    if (getMessage(ctx.cache, b.id)) continue;
    let body: string;
    try {
      body = open(b.body, ctx.me.boxPub, ctx.me.boxSec);
    } catch {
      body = "[unable to decrypt — not sealed to this identity]";
    }
    const row: MessageRow = {
      id: b.id,
      recipient: ctx.me.signPub,
      sender: b.sender,
      body,
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
    body: seal(body, to.boxPub),
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
      rememberContact(ctx, { name: args.to, signPub: keys.signPub, boxPub: keys.boxPub });
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
      from: displayNameByKey(ctx.book, m.sender),
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
    from: displayNameByKey(ctx.book, row.sender),
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
