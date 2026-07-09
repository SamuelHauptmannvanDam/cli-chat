// Phase 1 tool operations: encrypted + networked. Sending seals the body to the
// recipient and POSTs the blob to the hosted mailbox. Receiving drains blobs
// from the mailbox, decrypts them locally, and caches the plaintext in a
// per-user inbox DB — so read_message / previews keep their Phase 0 feel while
// the server only ever holds ciphertext.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeSecretAtomic } from "./secure-fs.ts";
import {
  getMessage,
  insertMessage,
  markRead,
  unreadFor,
  historyFor as historyRows,
  type MessageRow,
  type Mailbox,
} from "./db.ts";
import { appendToThread } from "./threads.ts";
import { screenBody } from "./screen.ts";
import {
  contactByKey,
  removeContactByKey,
  saveContacts,
  senderLabel,
  resolve,
  cleanName,
  cleanTag,
  addTag,
  removeTag,
  recordTagMeta,
  removeTagMeta,
  declineTag,
  suggestTagsFor,
  type Contact,
  type ContactBook,
  type TagSource,
  type TagSuggestion,
} from "./contacts.ts";
import { open, seal, type Identity } from "./crypto.ts";
import { isHandle, parseKey } from "./key-code.ts";
import type { FriendRequest, MailboxClient, RequestOutcome } from "./mailbox-client.ts";
import type { WireMessage } from "./identity.ts";

const SIGNPUB_RE = /^[0-9a-f]{64}$/;

export interface NetContext {
  me: Identity;
  book: ContactBook;
  cache: Mailbox; // local decrypted inbox
  client: MailboxClient; // hosted mailbox
  now: () => number;
  contactsPath?: string; // where to persist the book when a contact is added
  // Where the living thread files live (<user>/context/threads). When set, every
  // send + drain also appends to the contact's page (HISTORY.md). Optional so
  // tests / minimal contexts skip the file half; ALWAYS best-effort — history
  // files must never break a send or a drain.
  threadsPath?: string;
  // Contacts-of-contacts graph hooks (CONTACTS-OF-CONTACTS.md): fired after a
  // contact is saved / removed locally, so the edge can be pushed to the server.
  // Optional and fire-and-forget (tests/offline omit them; must never throw).
  onEdgeAdd?: (signPub: string) => void;
  onEdgeRemove?: (signPub: string) => void;
  // Fired after any contact-book write that happens INSIDE core paths (a sender
  // auto-saved on drain, a handle/selfName backfill) — so the owner can flag the
  // vault dirty. Without it those writes only reach other devices after some
  // unrelated tool mutation. Optional, fire-and-forget, must never throw.
  onBookChange?: () => void;
}

// Save (or update) a contact in the book and persist it to disk if we know
// where the book lives. signPub is the sole identity: we upsert on the key, so
// re-saving the same person replaces them while two different people may share a
// name (the resolver tells them apart, returning `ambiguous` on a name clash).
// `auto` marks a contact saved from a received self-introduction (their own name,
// not a nick you chose); a manual save/rename leaves it off so the nick wins.
export function rememberContact(
  ctx: NetContext,
  c: { name: string; signPub: string; boxPub: string; handle?: string; auto?: boolean; selfName?: string },
): void {
  // Upsert by key: drop any existing entry, but carry its self-name forward so a
  // rename (re-add with a new nick) doesn't lose what THEY call themselves.
  const prev = contactByKey(ctx.book, c.signPub);
  ctx.book.contacts = ctx.book.contacts.filter((x) => x.signPub !== c.signPub);
  const entry: Contact = { name: cleanName(c.name) || c.name, signPub: c.signPub, boxPub: c.boxPub };
  if (c.handle) entry.handle = c.handle;
  if (c.auto) entry.auto = true;
  const self = cleanName(c.selfName) || prev?.selfName;
  if (self) entry.selfName = self;
  // Carry local tags + their evidence/declines forward across the upsert — a rename
  // (re-add with a new nick) must not wipe the labels or the why behind them.
  if (prev?.tags?.length) entry.tags = [...prev.tags];
  if (prev?.tagMeta?.length) entry.tagMeta = prev.tagMeta.map((m) => ({ ...m, evidence: m.evidence ? [...m.evidence] : undefined }));
  if (prev?.declinedTags?.length) entry.declinedTags = [...prev.declinedTags];
  ctx.book.contacts.push(entry);
  if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  // Contribute this edge to the second-degree graph (best-effort, deduped server
  // side). Fires for every save path — manual add, send-to-new, incoming auto-save.
  ctx.onEdgeAdd?.(c.signPub);
  ctx.onBookChange?.();
}

// A message body packs a small self-introduction alongside the text, sealed to
// the recipient so only they (not the mailbox) can read it: who sent it (their
// chosen name + 6-char handle) and the X25519 key to reply to. This is what lets
// a recipient SEE who an unknown sender is and reply without a prior contact.
const ENVELOPE_V = 1;

export function packBody(me: Identity, text: string, opts?: { assistant?: boolean }): string {
  const env: {
    v: number;
    text: string;
    name?: string;
    handle?: string;
    boxPub: string;
    answered_by?: string;
  } = {
    v: ENVELOPE_V,
    text,
    boxPub: me.boxPub, // reply key — lets a stranger be answered + auto-saved
  };
  if (me.name) env.name = me.name;
  if (me.handle) env.handle = me.handle;
  // Machine-readable assistant mark (AUTO-CHAT.md): packed INSIDE the sealed body
  // (invisible to the relay). Back-compat: absent = a human wrote it.
  if (opts?.assistant) env.answered_by = "assistant";
  return JSON.stringify(env);
}

export interface Unpacked {
  text: string;
  name?: string;
  handle?: string;
  boxPub?: string;
  answered_by?: "assistant";
}

// Inverse of packBody. Legacy/plain bodies aren't our JSON envelope, so they pass
// through as plain text with no metadata — full back-compat with messages sent
// before this existed.
export function unpackBody(plaintext: string): Unpacked {
  try {
    const o = JSON.parse(plaintext) as Record<string, unknown>;
    if (o && typeof o === "object" && o.v === ENVELOPE_V && typeof o.text === "string") {
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      return {
        text: o.text,
        name: str(o.name),
        handle: str(o.handle),
        boxPub: str(o.boxPub),
        // Only the one recognised value — anything else a sender invents is ignored.
        answered_by: o.answered_by === "assistant" ? "assistant" : undefined,
      };
    }
  } catch {
    /* not our envelope — treat as a plain legacy body */
  }
  return { text: plaintext };
}

// The human-readable half of the assistant mark: a trailing line ANY recipient
// sees, even with no feature on their side. Appended in code (not by the model)
// so there is no unmarked mode.
export function assistantMark(me: Identity): string {
  return `\n\n— ${me.name ? `${me.name}'s` : "an"} assistant`;
}

// How a message row's writer is labelled in feeds/results. Self-mail (the
// escalate-by-mail path, or a note to self) never shows as a contact: the
// assistant's own questions read as "your assistant", anything else from the
// user's own identity as "Me".
function labelForRow(ctx: NetContext, row: { sender: string; answered_by?: string | null }): string {
  if (row.sender === ctx.me.signPub)
    return row.answered_by === "assistant" ? "your assistant" : "Me";
  return senderLabel(ctx.book, row.sender);
}

// Best-effort thread-file append (HISTORY.md): only when the context carries a
// threads dir, never for self-mail (a note to self isn't a contact thread), and
// never allowed to break the calling send/drain.
function threadAppend(
  ctx: NetContext,
  other: { name: string; signPub: string },
  entry: { direction: "in" | "out"; who: string; body: string; at: number; assistant?: boolean },
): void {
  if (!ctx.threadsPath || other.signPub === ctx.me.signPub) return;
  try {
    const name = contactByKey(ctx.book, other.signPub)?.name ?? other.name;
    appendToThread(ctx.threadsPath, { name, signPub: other.signPub }, entry, ctx.now());
  } catch {
    /* the living page is a projection — the db still has the row */
  }
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
  const name = cleanName(args.name) || args.name;
  rememberContact(ctx, { name, signPub: keys.signPub, boxPub: keys.boxPub, handle: keys.handle });
  return { ok: true, name };
}

export type DeleteContactResult =
  | { ok: true; name: string }
  | { ok: false; reason: "no_contact" | "ambiguous"; query: string; candidates?: string[] };

// Remove a saved contact by name. Resolution mirrors send_message: a partial
// name is fine ("Niels" finds "Niels - bankdata"), `no_contact` means nothing
// matched, and `ambiguous` returns the candidate names so the caller can ask
// which one rather than deleting the wrong person. Deletion itself is keyed on
// signPub, so exactly the resolved entry is dropped.
export function deleteContact(
  ctx: NetContext,
  args: { name: string },
): DeleteContactResult {
  const r = resolve(ctx.book, args.name);
  if (r.status === "none") return { ok: false, reason: "no_contact", query: args.name };
  if (r.status === "ambiguous")
    return {
      ok: false,
      reason: "ambiguous",
      query: args.name,
      candidates: r.candidates.map((c) => c.name),
    };
  const c = r.contact;
  if (c.signPub) removeContactByKey(ctx.book, c.signPub);
  else ctx.book.contacts = ctx.book.contacts.filter((x) => x !== c); // legacy keyless entry
  if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  if (c.signPub) ctx.onEdgeRemove?.(c.signPub); // drop the edge from the graph
  return { ok: true, name: c.name };
}

export type TagContactResult =
  | { ok: true; name: string; tag: string; tags: string[]; changed: boolean }
  | { ok: false; reason: "no_contact" | "ambiguous" | "bad_tag"; query: string; candidates?: string[] };

// Resolve a name the same way send_message/delete_contact does, then add a LOCAL
// tag. Tags never leave the device. Also records WHY (2a-iii): `source` (manual /
// self / cross) and any `evidence` tokens merge into the contact's tagMeta — even
// when the tag itself was already present, so evidence keeps accumulating. `changed`
// reflects the membership set (false = they already had the tag), which is what the
// agent uses to decide whether to announce a contact's FIRST tag.
export function tagContact(
  ctx: NetContext,
  args: { name: string; tag: string; source?: TagSource; evidence?: string[] },
): TagContactResult {
  const found = resolveForTag(ctx, args);
  if (!found.ok) return found.err;
  const c = found.contact;
  const changed = addTag(c, args.tag);
  const metaChanged = recordTagMeta(c, args.tag, {
    source: args.source ?? "manual",
    evidence: args.evidence,
    now: ctx.now(),
  });
  if ((changed || metaChanged) && ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  return { ok: true, name: c.name, tag: cleanTag(args.tag), tags: c.tags ?? [], changed };
}

// Remove a tag and its evidence. `changed` reflects whether the tag was present.
export function untagContact(
  ctx: NetContext,
  args: { name: string; tag: string },
): TagContactResult {
  const found = resolveForTag(ctx, args);
  if (!found.ok) return found.err;
  const c = found.contact;
  const changed = removeTag(c, args.tag);
  const metaChanged = removeTagMeta(c, args.tag);
  if ((changed || metaChanged) && ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  return { ok: true, name: c.name, tag: cleanTag(args.tag), tags: c.tags ?? [], changed };
}

// Shared front half of tag/untag: validate the tag and resolve the name, returning
// either the resolved contact or the failure result both tools share.
function resolveForTag(
  ctx: NetContext,
  args: { name: string; tag: string },
): { ok: true; contact: Contact } | { ok: false; err: TagContactResult } {
  if (!cleanTag(args.tag)) return { ok: false, err: { ok: false, reason: "bad_tag", query: args.name } };
  const r = resolve(ctx.book, args.name);
  if (r.status === "none")
    return { ok: false, err: { ok: false, reason: "no_contact", query: args.name } };
  if (r.status === "ambiguous")
    return {
      ok: false,
      err: { ok: false, reason: "ambiguous", query: args.name, candidates: r.candidates.map((c) => c.name) },
    };
  return { ok: true, contact: r.contact };
}

export type DeclineTagResult =
  | { ok: true; name: string; tag: string; removed: boolean; declined: boolean }
  | { ok: false; reason: "no_contact" | "ambiguous" | "bad_tag"; query: string; candidates?: string[] };

// Reject a tag for a contact: remove it if it was applied AND record the decline so
// cross-inference never re-suggests it. Covers both "no thanks" to a proposal (tag
// not present → just declined) and "remove this wrong auto-tag for good" (present →
// removed + declined). `untag_contact` stays a plain removal that CAN be re-suggested.
export function declineTagContact(
  ctx: NetContext,
  args: { name: string; tag: string },
): DeclineTagResult {
  const found = resolveForTag(ctx, args);
  if (!found.ok) return found.err as DeclineTagResult;
  const c = found.contact;
  const removed = removeTag(c, args.tag);
  removeTagMeta(c, args.tag);
  const declined = declineTag(c, args.tag);
  if ((removed || declined) && ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  return { ok: true, name: c.name, tag: cleanTag(args.tag), removed, declined };
}

export type SuggestTagsResult =
  | { ok: true; name: string; suggestions: TagSuggestion[] }
  | { ok: false; reason: "no_contact" | "ambiguous"; query: string; candidates?: string[] };

// Score a contact against your existing tag clusters and return likely tags (above
// the confidence bar). `signals` are tokens from their current message — topics plus
// any contact names they mention. Read-only: it suggests, it never applies.
export function suggestTags(
  ctx: NetContext,
  args: { name: string; signals?: string[] },
): SuggestTagsResult {
  const r = resolve(ctx.book, args.name);
  if (r.status === "none") return { ok: false, reason: "no_contact", query: args.name };
  if (r.status === "ambiguous")
    return { ok: false, reason: "ambiguous", query: args.name, candidates: r.candidates.map((c) => c.name) };
  return { ok: true, name: r.contact.name, suggestions: suggestTagsFor(ctx.book, r.contact, args.signals ?? []) };
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
    // Self-mail (escalate-by-mail / note to self, AUTO-CHAT.md): never auto-save
    // the user as their own contact, and never auto-tag from it — it just lands
    // in the cache and surfaces as "your assistant" / "Me".
    const fromSelf = b.sender === ctx.me.signPub;
    // Auto-save a genuinely new sender from the keys they introduced themselves
    // with, so "write <name>" works next time and a reply can be sealed. NEVER
    // clobber someone you already know — your nick for them wins.
    const known = b.sender && !fromSelf ? contactByKey(ctx.book, b.sender) : undefined;
    if (env.boxPub && b.sender && !fromSelf && !known) {
      const self = cleanName(env.name);
      const name = self || env.handle || `${b.sender.slice(0, 8)}…`;
      rememberContact(ctx, {
        name,
        signPub: b.sender,
        boxPub: env.boxPub,
        handle: env.handle,
        auto: true,
        selfName: self || undefined,
      });
    } else if (known) {
      // Known contact: NEVER touch name/nick/auto ("your nick wins"), but keep the
      // ambient facts current — backfill a missing handle, and refresh selfName from
      // their envelope so the contacts list reflects what they currently call
      // themselves even after you've renamed them.
      let changed = false;
      if (env.handle && !known.handle) {
        known.handle = env.handle;
        changed = true;
      }
      const self = cleanName(env.name);
      if (self && self !== known.selfName) {
        known.selfName = self;
        changed = true;
      }
      if (changed && ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
      if (changed) ctx.onBookChange?.();
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
      answered_by: env.answered_by ?? null,
    };
    insertMessage(ctx.cache, row);
    threadAppend(ctx, { name: senderLabel(ctx.book, b.sender), signPub: b.sender }, {
      direction: "in",
      who: senderLabel(ctx.book, b.sender),
      body: env.text,
      at: b.created_at,
      assistant: env.answered_by === "assistant",
    });
    added++;
  }
  return added;
}

export type SendResult =
  | { ok: true; id: string; to: { name: string; signPub: string }; saved?: boolean; self?: boolean }
  | {
      ok: false;
      reason: "no_contact" | "ambiguous" | "no_keys" | "bad_key";
      query: string;
      candidates?: string[];
    }
  // The name isn't a saved contact but DOES match a friend-of-friend, who is
  // name-only and not directly messageable — steer the caller to a connect request
  // (FRIENDS.md) instead of failing with no_contact.
  | { ok: false; reason: "needs_request"; query: string; signPub: string; name: string | null; via: string[] };

async function sendSealed(
  ctx: NetContext,
  to: { name: string; signPub: string; boxPub: string },
  body: string,
  in_reply_to: string | null,
  asAssistant = false,
): Promise<string> {
  // Assistant sends carry the mark twice (AUTO-CHAT.md): a visible trailing line
  // in the text itself (any recipient sees it, feature or not) AND the
  // machine-readable answered_by inside the envelope. No unmarked mode.
  const text = asAssistant ? body + assistantMark(ctx.me) : body;
  const createdAt = ctx.now();
  const wire: WireMessage = {
    id: randomUUID(),
    recipient: to.signPub,
    sender: ctx.me.signPub,
    body: seal(packBody(ctx.me, text, { assistant: asAssistant }), to.boxPub),
    tags: null,
    created_at: createdAt,
    in_reply_to,
  };
  await ctx.client.send(wire);
  // Outbound persistence (HISTORY.md): store our half of the thread, plaintext,
  // BORN READ (read_at = created_at) so it can never surface as inbox mail.
  // Best-effort — history must never turn a delivered send into an error.
  // NOT for self-sends: the drain brings the same id back as the inbound copy,
  // and a pre-existing born-read row would swallow it (the whole point of
  // self-mail is to SURFACE — the drained row is also the history record).
  try {
    if (to.signPub !== ctx.me.signPub)
      insertMessage(ctx.cache, {
        id: wire.id,
        recipient: to.signPub,
        sender: ctx.me.signPub,
        body: text,
        tags: null,
        created_at: createdAt,
        fetched_at: createdAt,
        read_at: createdAt,
        in_reply_to,
        answered_by: asAssistant ? "assistant" : null,
      });
  } catch {
    /* cache hiccup — the send already succeeded */
  }
  threadAppend(ctx, to, { direction: "out", who: "me", body: text, at: createdAt, assistant: asAssistant });
  // Tally the send against the contact so the contacts list can lead with the
  // people you actually talk to. Bumped only after the send succeeds, and only
  // for a saved contact (anonymous/key-only sends have an entry by now too, since
  // sendMessage remembers them first). Persisted like every other book mutation.
  const contact = ctx.book.contacts.find((c) => c.signPub === to.signPub);
  if (contact) {
    contact.sentCount = (contact.sentCount ?? 0) + 1;
    contact.lastMessageAt = ctx.now();
    if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  }
  return wire.id;
}

// Best-effort: does this name match a single friend-of-friend? Returns a
// `needs_request` steer if so, else null (offline / no match / ambiguous → let the
// caller fall back to no_contact). Case-insensitive substring match on self-names.
async function matchNetwork(
  ctx: NetContext,
  name: string,
): Promise<Extract<SendResult, { reason: "needs_request" }> | null> {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  let net;
  try {
    net = await ctx.client.getNetwork();
  } catch {
    return null;
  }
  const hits = net.filter((p) => (p.name ?? "").toLowerCase().includes(q));
  if (hits.length !== 1) return null; // no match, or ambiguous → not a clean steer
  const p = hits[0]!;
  const nick = (sp: string) =>
    ctx.book.contacts.find((c) => c.signPub === sp)?.name ?? `${sp.slice(0, 8)}…`;
  return { ok: false, reason: "needs_request", query: name, signPub: p.signPub, name: p.name, via: p.via.map(nick) };
}

// Mail your own handle (AUTO-CHAT.md self-send): the escalate-by-mail path and
// "note to self". The user is never saved as their own contact; the message
// travels the normal sealed route and surfaces wherever they're next active.
async function sendToSelf(ctx: NetContext, body: string, asAssistant: boolean): Promise<SendResult> {
  const id = await sendSealed(
    ctx,
    { name: "Me", signPub: ctx.me.signPub, boxPub: ctx.me.boxPub },
    body,
    null,
    asAssistant,
  );
  return { ok: true, id, to: { name: "Me", signPub: ctx.me.signPub }, self: true };
}

const SELF_WORDS = new Set(["me", "myself", "self"]);

// Send to a known contact by name, OR to a brand-new person via their key code
// (in which case we save them as a contact named `to` for next time), OR to the
// user's own identity ("me"/their own name) — the self-send path.
export async function sendMessage(
  ctx: NetContext,
  args: { to: string; body: string; key?: string; as_assistant?: boolean },
): Promise<SendResult> {
  const asAssistant = args.as_assistant === true;
  // "me"/"myself" always means the user, even if a contact shares the word.
  if (SELF_WORDS.has(args.to.trim().toLowerCase())) return sendToSelf(ctx, args.body, asAssistant);

  const r = resolve(ctx.book, args.to);

  if (r.status === "none") {
    // No such contact. If the user supplied a key code or handle, resolve it,
    // remember them under the name they gave, and send.
    if (args.key) {
      if (!parseKey(args.key) && !isHandle(args.key))
        return { ok: false, reason: "bad_key", query: args.to };
      const keys = await resolveCode(ctx, args.key);
      if (!keys) return { ok: false, reason: "bad_key", query: args.to };
      // The code resolved to the user's own identity → self-send, never self-save.
      if (keys.signPub === ctx.me.signPub) return sendToSelf(ctx, args.body, asAssistant);
      rememberContact(ctx, { name: args.to, signPub: keys.signPub, boxPub: keys.boxPub, handle: keys.handle });
      const id = await sendSealed(ctx, { name: args.to, ...keys }, args.body, null, asAssistant);
      return { ok: true, id, to: { name: args.to, signPub: keys.signPub }, saved: true };
    }
    // The user's own name/handle (no contact shadows it, since resolve came up
    // empty) → self-send.
    const q = args.to.trim().toLowerCase();
    if ((ctx.me.name && q === ctx.me.name.toLowerCase()) || (ctx.me.handle && q === ctx.me.handle.toLowerCase()))
      return sendToSelf(ctx, args.body, asAssistant);
    // Not a saved contact. Before failing, check the second-degree network: if the
    // name matches a friend-of-friend, they're name-only (not messageable yet), so
    // steer to a connect request rather than a dead "no_contact" (FRIENDS.md).
    const fof = await matchNetwork(ctx, args.to);
    if (fof) return fof;
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

  const id = await sendSealed(ctx, { name: c.name, signPub: c.signPub, boxPub: c.boxPub }, args.body, null, asAssistant);
  return { ok: true, id, to: { name: c.name, signPub: c.signPub } };
}

export interface InboxMessage {
  id: string;
  from: string;
  body: string;
  at: number;
  in_reply_to: string | null;
  // Self-mail marker (escalate-by-mail / note to self): from the user's OWN
  // identity. Never auto-tagged; the quiet-assist hook lets ONLY these through.
  self?: boolean;
  // "assistant" when the sender's agent wrote it (renders as "<name>'s assistant").
  answered_by?: string;
  // Injection / privilege-overreach flags from the screen (screen.ts). Present →
  // NEVER auto-answer; surface to the human with the flag. A tripwire, not proof.
  warnings?: string[];
}

// Shared row → feed-message shape (labels self-mail as "your assistant"/"Me").
function toInboxMessage(ctx: NetContext, m: MessageRow): InboxMessage {
  const warnings = screenBody(m.body);
  return {
    id: m.id,
    from: labelForRow(ctx, m),
    body: m.body,
    at: m.created_at,
    in_reply_to: m.in_reply_to,
    ...(m.sender === ctx.me.signPub ? { self: true } : {}),
    ...(m.answered_by ? { answered_by: m.answered_by } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

// Take every currently-unread message, marking each read, with the FULL body —
// the receive shape `chat_batch` hands straight to the user when there's no fresh
// warmer snapshot. Kept here (not inlined in the tool) so it shares the
// sender-labelling and read semantics with the rest of the receive path instead
// of the tool reaching into the cache directly.
export function takeUnread(ctx: NetContext): InboxMessage[] {
  return unreadFor(ctx.cache, ctx.me.signPub).map((m) => {
    markRead(ctx.cache, m.id, ctx.now());
    return toInboxMessage(ctx, m);
  });
}

// ---- pending snapshot: the warmer→hook channel (PUSH.md / db.ts cross-process) ----
// The session hook can't safely open inbox.db while the warmer holds it (the wasm
// driver's cross-process lock — the old "mail never surfaced" bug). So the warmer
// (sole writer) mirrors current unread mail here, already decrypted, and the hook
// just reads it. Read-state stays in SQLite; a message is marked read ONLY once the
// hook acks it (writePendingAck → refreshPending), never at queue time — so
// chat_batch and messages_available aren't starved, and nothing is lost if the
// hook never runs.

export interface PendingSnapshot {
  writtenAt: number;
  messages: InboxMessage[];
  // false → this is only the boot seed (mirrored from the local cache before the
  // warmer's first network drain), so it may be missing mail that's already on the
  // server. true → written after a real `sync`, so it reflects the server. The
  // SessionStart hook waits for a `synced` snapshot to avoid the cold-open race
  // where it reads the seed and shows "no mail" for something already waiting.
  synced?: boolean;
}

function writeJsonAtomic(path: string, value: unknown): void {
  // pending.json carries decrypted message bodies, so keep it 0600 like the keys.
  writeSecretAtomic(path, JSON.stringify(value, null, 2) + "\n");
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
export function refreshPending(
  ctx: NetContext,
  pendingPath: string,
  ackPath: string,
  synced = true,
): void {
  for (const id of readAck(ackPath)) markRead(ctx.cache, id, ctx.now());
  const messages: InboxMessage[] = unreadFor(ctx.cache, ctx.me.signPub).map((m) =>
    toInboxMessage(ctx, m),
  );
  writeJsonAtomic(pendingPath, { writtenAt: ctx.now(), messages, synced } satisfies PendingSnapshot);
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
      from: labelForRow(ctx, m),
      preview: m.body.length > 200 ? m.body.slice(0, 197) + "..." : m.body,
      at: m.created_at,
    })),
  };
}

export type ReadResult =
  | {
      ok: true;
      id: string;
      from: string;
      body: string;
      at: number;
      in_reply_to: string | null;
      self?: boolean;
      answered_by?: string;
    }
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
  return { ok: true, ...toInboxMessage(ctx, row) };
}

export type ReplyResult =
  | { ok: true; id: string; to: { name: string; signPub: string }; self?: boolean }
  | { ok: false; reason: "not_found" | "no_keys" };

export async function draftReply(
  ctx: NetContext,
  args: { in_reply_to: string; body: string; as_assistant?: boolean },
): Promise<ReplyResult> {
  const original = getMessage(ctx.cache, args.in_reply_to);
  if (!original) return { ok: false, reason: "not_found" };
  const asAssistant = args.as_assistant === true;

  // Replying to an OUTBOUND row (a history slice includes both halves) goes to
  // its recipient; replying to inbound goes to its sender. A self-mail thread
  // (escalation) answers back to the user's own identity.
  const other = original.sender === ctx.me.signPub ? original.recipient : original.sender;
  if (other === ctx.me.signPub) {
    const id = await sendSealed(
      ctx,
      { name: "Me", signPub: ctx.me.signPub, boxPub: ctx.me.boxPub },
      args.body,
      original.id,
      asAssistant,
    );
    return { ok: true, id, to: { name: "Me", signPub: ctx.me.signPub }, self: true };
  }

  const c = contactByKey(ctx.book, other);
  if (!c || !c.signPub || !c.boxPub) return { ok: false, reason: "no_keys" };

  const id = await sendSealed(
    ctx,
    { name: c.name, signPub: c.signPub, boxPub: c.boxPub },
    args.body,
    original.id,
    asAssistant,
  );
  return { ok: true, id, to: { name: c.name, signPub: c.signPub } };
}

// --- history (HISTORY.md): the recall door over the local cache ------------

export type HistoryResult =
  | {
      ok: true;
      with: string | null;
      messages: {
        id: string;
        direction: "in" | "out";
        who: string;
        body: string;
        at: number;
        in_reply_to: string | null;
        answered_by?: string;
      }[];
    }
  | { ok: false; reason: "no_contact" | "ambiguous"; query: string; candidates?: string[] };

// A chronological slice of the thread (both directions), read-only — it NEVER
// touches read_at, so unread mail in a slice still surfaces through the normal
// inbox paths. Syncs first (best-effort) so the slice includes mail that landed
// seconds ago; offline it still serves the local cache.
export async function messageHistory(
  ctx: NetContext,
  args: { with?: string; limit?: number; before?: number; q?: string },
): Promise<HistoryResult> {
  try {
    await sync(ctx);
  } catch {
    /* offline — local history still answers */
  }
  let other: Contact | null = null;
  if (args.with?.trim()) {
    const r = resolve(ctx.book, args.with);
    if (r.status === "none") return { ok: false, reason: "no_contact", query: args.with };
    if (r.status === "ambiguous")
      return {
        ok: false,
        reason: "ambiguous",
        query: args.with,
        candidates: r.candidates.map((c) => c.name),
      };
    if (!r.contact.signPub) return { ok: false, reason: "no_contact", query: args.with };
    other = r.contact;
  }
  const rows = historyRows(ctx.cache, ctx.me.signPub, other?.signPub ?? null, {
    limit: args.limit,
    before: args.before,
    q: args.q,
  });
  return {
    ok: true,
    with: other?.name ?? null,
    messages: rows.map((r) => ({
      id: r.id,
      direction: r.sender === ctx.me.signPub ? ("out" as const) : ("in" as const),
      who: r.sender === ctx.me.signPub ? "me" : labelForRow(ctx, r),
      body: r.body,
      at: r.created_at,
      in_reply_to: r.in_reply_to,
      ...(r.answered_by ? { answered_by: r.answered_by } : {}),
    })),
  };
}

// --- Friend requests (FRIENDS.md) ------------------------------------------
// The consent handshake for the network path. A friend-of-friend is discovered
// as a NAME + signPub only (no boxPub → un-messageable); you reach them by
// sending a connect request they accept. Acceptance is the key exchange: both
// sides gain the other's boxPub and become confirmed (mutual-edge) friends.

export type RequestContactResult =
  | { ok: true }
  | { ok: false; reason: RequestOutcome | "bad_target" };

// Send a connect request to a second-degree person, addressed by their signPub
// (from the contacts-of-contacts list). `via` is an optional contact NAME we
// resolve to the mutual's key, so the recipient sees "via <that person>".
export async function requestContact(
  ctx: NetContext,
  args: { signPub: string; via?: string },
): Promise<RequestContactResult> {
  const to = (args.signPub ?? "").trim();
  if (!SIGNPUB_RE.test(to)) return { ok: false, reason: "bad_target" };
  let viaKey: string | null = null;
  if (args.via) {
    const r = resolve(ctx.book, args.via);
    if (r.status !== "none" && r.status !== "ambiguous" && r.contact.signPub)
      viaKey = r.contact.signPub;
  }
  const outcome = await ctx.client.requestContact(to, viaKey);
  return outcome === "ok" ? { ok: true } : { ok: false, reason: outcome };
}

export interface IncomingRequest {
  signPub: string;
  name: string | null; // the requester's OWN self-name (untrusted, sanitised)
  via: string[]; // your nickname(s) for the mutual it came through
  at: number;
}

// Your incoming connect requests, plus any accepts that have landed since last
// check (people who accepted YOUR request) — those are drained and saved as
// contacts here, since the connection is already mutually agreed. Returns the
// saved names so the caller can report "X accepted — added to your contacts".
export async function listRequests(
  ctx: NetContext,
): Promise<{ incoming: IncomingRequest[]; accepted: string[] }> {
  const accepted = await drainAccepts(ctx);
  let reqs: FriendRequest[] = [];
  try {
    reqs = await ctx.client.getRequests();
  } catch {
    reqs = [];
  }
  const nick = (sp: string) =>
    ctx.book.contacts.find((c) => c.signPub === sp)?.name ?? `${sp.slice(0, 8)}…`;
  const incoming = reqs.map((r) => ({
    signPub: r.fromSignPub,
    name: cleanName(r.fromName) || null,
    via: r.viaSignPub ? [nick(r.viaSignPub)] : [],
    at: r.createdAt,
  }));
  return { incoming, accepted };
}

// Drain the accept-inbox: for each person who accepted a request of yours, save
// them locally (you now hold their boxPub, so you can message them). Best-effort.
export async function drainAccepts(ctx: NetContext): Promise<string[]> {
  let accepts;
  try {
    accepts = await ctx.client.takeAccepts();
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const a of accepts) {
    if (!SIGNPUB_RE.test(a.signPub) || !a.boxPub) continue;
    const self = cleanName(a.name);
    const name = self || `${a.signPub.slice(0, 8)}…`;
    rememberContact(ctx, {
      name,
      signPub: a.signPub,
      boxPub: a.boxPub,
      auto: true,
      selfName: self || undefined,
    });
    names.push(name);
  }
  return names;
}

export type AcceptRequestResult =
  | { ok: true; name: string }
  | { ok: false; reason: "no_request" | "bad_target" };

// Accept an incoming request: the server hands back the requester's identity
// (they were confirmed mutual on their side), which we save locally.
export async function acceptRequest(
  ctx: NetContext,
  args: { signPub: string },
): Promise<AcceptRequestResult> {
  const from = (args.signPub ?? "").trim();
  if (!SIGNPUB_RE.test(from)) return { ok: false, reason: "bad_target" };
  const contact = await ctx.client.acceptRequest(from);
  if (!contact) return { ok: false, reason: "no_request" };
  const self = cleanName(contact.name);
  const name = self || `${contact.signPub.slice(0, 8)}…`;
  rememberContact(ctx, {
    name,
    signPub: contact.signPub,
    boxPub: contact.boxPub,
    auto: true,
    selfName: self || undefined,
  });
  return { ok: true, name };
}

export type DeclineRequestResult =
  | { ok: true }
  | { ok: false; reason: "bad_target" };

// Dismiss an incoming request without connecting.
export async function declineRequest(
  ctx: NetContext,
  args: { signPub: string },
): Promise<DeclineRequestResult> {
  const from = (args.signPub ?? "").trim();
  if (!SIGNPUB_RE.test(from)) return { ok: false, reason: "bad_target" };
  await ctx.client.declineRequest(from);
  return { ok: true };
}
