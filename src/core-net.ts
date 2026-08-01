// Phase 1 tool operations: encrypted + networked. Sending seals the body to the
// recipient and POSTs the blob to the hosted mailbox. Receiving drains blobs
// from the mailbox, decrypts them locally, and caches the plaintext in a
// per-user inbox DB — so read_message / previews keep their Phase 0 feel while
// the server only ever holds ciphertext.

import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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
  resolveGroup,
  groupById,
  GROUP_MAX_MEMBERS,
  type Contact,
  type ContactBook,
  type Group,
  type GroupMember,
  type TagSource,
  type TagSuggestion,
} from "./contacts.ts";
import { open, seal, type Identity } from "./crypto.ts";
import { isHandle, parseKey } from "./key-code.ts";
import type { FriendRequest, MailboxClient, RequestOutcome } from "./mailbox-client.ts";
import type { WireMessage } from "./identity.ts";

const SIGNPUB_RE = /^[0-9a-f]{64}$/;
// Loose email shape for the send-by-email path (EMAIL-SEND.md); the server
// validates again with the same pattern.
const EMAIL_ADDR_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  // Fired for every message this device SEES (a row inserted on send or drain),
  // so the owner can queue it for the account's history stream (history-sync.ts).
  // Never fired for rows applied FROM the stream — that would loop. Optional,
  // fire-and-forget, must never throw or break a send/drain.
  onHistoryAppend?: (row: MessageRow) => void;
  // The NEW-HANDLE GATE's public-mode probe (0.18): when this returns true (a live
  // chat session started with `public: true` — see readChatLock), a first-time
  // sender is auto-saved and flows straight into the inbox, exactly the pre-gate
  // behavior. Absent or false → unknown senders are held as gated ("pending").
  allowNewSenders?: () => boolean;
}

// Save (or update) a contact in the book and persist it to disk if we know
// where the book lives. signPub is the sole identity: we upsert on the key, so
// re-saving the same person replaces them while two different people may share a
// name (the resolver tells them apart, returning `ambiguous` on a name clash).
// `auto` marks a contact saved from a received self-introduction (their own name,
// not a nick you chose); a manual save/rename leaves it off so the nick wins.
export function rememberContact(
  ctx: NetContext,
  c: { name: string; signPub: string; boxPub: string; handle?: string; email?: string; auto?: boolean; selfName?: string; gated?: "pending" },
): void {
  // Upsert by key: drop any existing entry, but carry its self-name forward so a
  // rename (re-add with a new nick) doesn't lose what THEY call themselves.
  // A save-by-email placeholder (keyless, EMAIL-SEND.md) counts as the previous
  // entry too: the first resolve of that address merges it — nick, tags,
  // evidence — instead of leaving a duplicate person behind.
  const emailTwin = c.email
    ? ctx.book.contacts.find((x) => !x.signPub && x.email?.toLowerCase() === c.email!.toLowerCase())
    : undefined;
  const prev = contactByKey(ctx.book, c.signPub) ?? emailTwin;
  ctx.book.contacts = ctx.book.contacts.filter((x) => x.signPub !== c.signPub && x !== emailTwin);
  const entry: Contact = { name: cleanName(c.name) || c.name, signPub: c.signPub, boxPub: c.boxPub };
  // A placeholder's nick was chosen by the user on purpose ("add Sam, sam@x.dk"),
  // so it outranks a name derived from the address at send time.
  if (prev === emailTwin && emailTwin && !emailTwin.auto) entry.name = emailTwin.name;
  // Carry the known handle forward like selfName: a re-save by full key (the
  // rename flow) brings no handle, and must not lose the one already on file.
  if (c.handle) entry.handle = c.handle;
  else if (prev?.handle) entry.handle = prev.handle;
  // Same for the email a contact was first written at (EMAIL-SEND.md).
  if (c.email) entry.email = c.email;
  else if (prev?.email) entry.email = prev.email;
  if (c.auto) entry.auto = true;
  if (c.gated) entry.gated = c.gated;
  const self = cleanName(c.selfName) || prev?.selfName;
  if (self) entry.selfName = self;
  // Carry local tags + their evidence/declines forward across the upsert — a rename
  // (re-add with a new nick) must not wipe the labels or the why behind them.
  if (prev?.tags?.length) entry.tags = [...prev.tags];
  if (prev?.tagMeta?.length) entry.tagMeta = prev.tagMeta.map((m) => ({ ...m, evidence: m.evidence ? [...m.evidence] : undefined }));
  if (prev?.declinedTags?.length) entry.declinedTags = [...prev.declinedTags];
  // Verification survives the upsert only while the box key is unchanged: the
  // safety number covers the keys, so a new boxPub under the same identity voids
  // the ✓ and raises the key-changed tripwire instead (verify flow in CLAUDE.md).
  if (prev?.verified) {
    if (prev.verified.boxPub === c.boxPub) entry.verified = prev.verified;
    else entry.keyChangedAt = Date.now();
  } else if (prev?.keyChangedAt) entry.keyChangedAt = prev.keyChangedAt;
  ctx.book.contacts.push(entry);
  if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  // Contribute this edge to the second-degree graph (best-effort, deduped server
  // side). Fires for every save path — manual add, send-to-new, incoming auto-save
  // — EXCEPT a gated hold: a stranger the user hasn't accepted isn't a confirmed
  // relationship, so the edge waits for the accept (acceptGatedContact).
  if (!entry.gated) ctx.onEdgeAdd?.(c.signPub);
  ctx.onBookChange?.();
}

// A message body packs a small self-introduction alongside the text, sealed to
// the recipient so only they (not the mailbox) can read it: who sent it (their
// chosen name + 6-char handle) and the X25519 key to reply to. This is what lets
// a recipient SEE who an unknown sender is and reply without a prior contact.
const ENVELOPE_V = 1;

// The group block a group message's envelope carries (GROUPS: 0.24). The server
// never sees it — it rides INSIDE the sealed body. `mid` is the canonical
// group-message id: the wire copies each get their own transport id (the server
// keys on it), but every member stores the message under `mid`, so replies
// thread identically on every device. `roster` is the full membership INCLUDING
// the sender (names are members' self-names, never someone's private nick) —
// carrying it in every message is what lets a receiver learn/heal the group
// with zero server involvement. `op` marks membership control messages; the
// roster itself is authoritative either way.
export interface WireGroup {
  id: string;
  name: string;
  mid: string;
  roster: { name?: string; signPub: string; boxPub: string }[];
  op?: GroupOp;
}

const GROUP_OPS = ["create", "add", "remove", "leave", "rename"] as const;
export type GroupOp = (typeof GROUP_OPS)[number];

const GROUP_ID_RE = /^g[0-9a-f]{8,32}$/;
const MID_RE = /^[\w-]{8,80}$/;
const BOXPUB_RE = /^[A-Za-z0-9+/=]{20,120}$/;

export function newGroupId(): string {
  return "g" + randomBytes(8).toString("hex");
}

export function packBody(
  me: Identity,
  text: string,
  opts?: { assistant?: boolean; group?: WireGroup },
): string {
  const env: {
    v: number;
    text: string;
    name?: string;
    handle?: string;
    boxPub: string;
    answered_by?: string;
    group?: WireGroup;
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
  if (opts?.group) env.group = opts.group;
  return JSON.stringify(env);
}

export interface Unpacked {
  text: string;
  name?: string;
  handle?: string;
  boxPub?: string;
  answered_by?: "assistant";
  group?: WireGroup;
}

// A sender-controlled group block is untrusted like everything else in the
// body: validate every field's shape and bound the roster, or drop the block
// entirely (the message still lands as a plain 1:1).
function parseWireGroup(v: unknown): WireGroup | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !GROUP_ID_RE.test(o.id)) return undefined;
  if (typeof o.mid !== "string" || !MID_RE.test(o.mid)) return undefined;
  const name = cleanName(typeof o.name === "string" ? o.name : "") || "group";
  if (!Array.isArray(o.roster)) return undefined;
  const roster: WireGroup["roster"] = [];
  for (const m of o.roster.slice(0, GROUP_MAX_MEMBERS)) {
    if (!m || typeof m !== "object") continue;
    const e = m as Record<string, unknown>;
    if (typeof e.signPub !== "string" || !SIGNPUB_RE.test(e.signPub)) continue;
    if (typeof e.boxPub !== "string" || !BOXPUB_RE.test(e.boxPub)) continue;
    roster.push({
      signPub: e.signPub,
      boxPub: e.boxPub,
      name: cleanName(typeof e.name === "string" ? e.name : "") || undefined,
    });
  }
  const op = GROUP_OPS.includes(o.op as GroupOp) ? (o.op as GroupOp) : undefined;
  return { id: o.id, name, mid: o.mid, roster, op };
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
        group: parseWireGroup(o.group),
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
  | { ok: true; name: string; email?: string; pending?: boolean }
  | { ok: false; reason: "bad_key" | "bad_email" | "not_found" };

// Add a contact from a shared code (handle or full key) — conversational
// onboarding. Or from an EMAIL ADDRESS: that save is deliberately SILENT — no
// message, no invite, not even a server call (the address never leaves this
// device). The entry sits keyless (`pending`) until the user first actually
// writes them; the send path then resolves the address, which is also the
// moment a non-user's once-ever invite email goes out (EMAIL-SEND.md).
export async function addContact(
  ctx: NetContext,
  args: { name: string; key?: string; email?: string },
): Promise<AddContactResult> {
  const email = args.email?.trim().toLowerCase();
  if (email) {
    if (!EMAIL_ADDR_RE.test(email)) return { ok: false, reason: "bad_email" };
    const name = cleanName(args.name) || args.name;
    // Upsert by address, mirroring the key path's rename semantics: re-adding
    // an email already on file (keyed or still pending) just renames them.
    const prev = ctx.book.contacts.find((x) => x.email?.toLowerCase() === email);
    if (prev) {
      prev.name = name;
      delete prev.auto; // a user-chosen nick replaces an auto-saved label
    } else {
      ctx.book.contacts.push({ name, email });
    }
    if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
    ctx.onBookChange?.();
    return { ok: true, name, email, pending: !prev?.signPub || undefined };
  }
  if (!args.key || (!parseKey(args.key) && !isHandle(args.key))) return { ok: false, reason: "bad_key" };
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

// Resolve a name the same way send_message/update_contact does, then add a LOCAL
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
// removed + declined). tag_contact action:'remove' stays a plain removal that CAN be re-suggested.
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
    if (ingestWireMessage(ctx, b, plain)) added++;
  }
  return added;
}

// Ingest ONE decrypted wire message into the local cache + contact book — the
// shared tail of every drain. `plain` is the already-opened body. Exported so
// the email-stub adoption path (EMAIL-SEND.md: mail that waited on a
// provisional identity, opened with the stub's keys) reuses the exact same
// gating/auto-save/history behavior as a normal sync. Returns false when the
// id was already cached.
export function ingestWireMessage(ctx: NetContext, b: WireMessage, plain: string): boolean {
  if (getMessage(ctx.cache, b.id)) return false;
  {
    // Split the text from the sender's self-introduction. Only the text is cached;
    // the identity feeds the contact book.
    const env = unpackBody(plain);
    // A group copy is stored under the shared mid (every member keys the message
    // the same way, so replies thread identically everywhere) — dedupe on it too.
    const g = env.group;
    if (g && getMessage(ctx.cache, g.mid)) return false;
    // Self-mail (escalate-by-mail / note to self, AUTO-CHAT.md): never auto-save
    // the user as their own contact, and never auto-tag from it — it just lands
    // in the cache and surfaces as "your assistant" / "Me".
    const fromSelf = b.sender === ctx.me.signPub;
    // Membership vouches (GROUPS): a sender the user doesn't know, writing into a
    // group the user IS in (the group id is secret to its members) and listed in
    // its stored roster, was introduced by whoever brought the group here — they
    // come through ungated. Any other stranger is held as usual, group field or
    // not (a made-up group id vouches for nothing).
    const knownGroup = g && !fromSelf ? groupById(ctx.book, g.id) : undefined;
    const viaGroup =
      !!knownGroup && !knownGroup.left && !!b.sender &&
      knownGroup.members.some((m) => m.signPub === b.sender);
    // A genuinely new sender: save the keys they introduced themselves with, so a
    // reply can be sealed — but GATED ("pending", the new-handle gate) unless a
    // public chat session is live (allowNewSenders). While gated their messages
    // stay out of the model's paths (takeUnread/refreshPending filter them)
    // until the user accepts. NEVER
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
        gated: viaGroup || ctx.allowNewSenders?.() ? undefined : "pending",
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
    // Learn / heal the group from the envelope's roster — but ONLY from a sender
    // who is a saved, ungated contact by now (a held stranger's roster claims wait
    // sealed with the rest of their message, and a keyless unknown sender — no
    // boxPub, so never saved — vouches for nothing: nothing an unconsented sender
    // asserts reshapes the book).
    const senderContact = b.sender && !fromSelf ? contactByKey(ctx.book, b.sender) : undefined;
    const senderTrusted = !!senderContact && !senderContact.gated;
    const groupName = g && senderTrusted ? learnGroup(ctx, g, b.sender) : undefined;
    const row: MessageRow = {
      id: g ? g.mid : b.id,
      recipient: ctx.me.signPub,
      sender: b.sender,
      body: env.text,
      tags: b.tags,
      created_at: b.created_at,
      fetched_at: ctx.now(),
      read_at: null,
      in_reply_to: b.in_reply_to,
      answered_by: env.answered_by ?? null,
      ...(g ? { group_id: g.id, group_name: groupName ?? (cleanName(g.name) || "group") } : {}),
    };
    insertMessage(ctx.cache, row);
    try {
      ctx.onHistoryAppend?.(row);
    } catch {
      /* history queueing must never break a drain */
    }
    // A group message's thread entry goes to the GROUP's page, keyed by group id.
    const threadKey = g
      ? { name: row.group_name ?? "group", signPub: g.id }
      : { name: senderLabel(ctx.book, b.sender), signPub: b.sender };
    threadAppend(ctx, threadKey, {
      direction: "in",
      who: senderLabel(ctx.book, b.sender),
      body: env.text,
      at: b.created_at,
      assistant: env.answered_by === "assistant",
    });
  }
  return true;
}

// Upsert a group from a received envelope's roster. The roster is authoritative
// (it rides every message, so the newest send heals any divergence) — with two
// sanity rules: the sender must themselves appear in the roster they assert
// (except a leave, where their absence IS the assertion), and if the roster no
// longer includes the user, the group flips to `left` (they were removed).
// Returns the group's current display name for the row.
function learnGroup(ctx: NetContext, g: WireGroup, sender: string): string | undefined {
  if (sender === ctx.me.signPub) return groupById(ctx.book, g.id)?.name;
  const senderInRoster = g.roster.some((m) => m.signPub === sender);
  if (!senderInRoster && g.op !== "leave") return groupById(ctx.book, g.id)?.name;
  const meIn = g.roster.some((m) => m.signPub === ctx.me.signPub);
  const members: GroupMember[] = g.roster
    .filter((m) => m.signPub !== ctx.me.signPub)
    .map((m) => ({ name: m.name ?? `${m.signPub.slice(0, 8)}…`, signPub: m.signPub, boxPub: m.boxPub }));
  // A leaver drops out of the roster they send; keep them out of members too.
  const name = cleanName(g.name) || "group";
  const existing = groupById(ctx.book, g.id);
  if (existing) {
    existing.name = name;
    existing.members = members;
    if (meIn) delete existing.left;
    else existing.left = true;
  } else {
    (ctx.book.groups ??= []).push({
      id: g.id,
      name,
      members,
      createdAt: ctx.now(),
      ...(meIn ? {} : { left: true }),
    });
  }
  persistBook(ctx);
  return name;
}

export type SendResult =
  // `email` rides along when the send addressed (and saved) someone by email —
  // it's the identifier the caller shows where a handle would go.
  | { ok: true; id: string; to: { name: string; signPub: string; keyChanged?: boolean }; saved?: boolean; self?: boolean; acceptedHandle?: boolean; email?: string; group?: undefined }
  // A group send (multi-recipient, a group name, or a group reply) — see GroupSendOk.
  | GroupSendOk
  // The user left (or was removed from) that group — sends to it are refused.
  | { ok: false; reason: "left_group"; query: string }
  | {
      ok: false;
      reason: "no_contact" | "ambiguous" | "no_keys" | "bad_key";
      query: string;
      candidates?: string[];
    }
  // Neither `to` nor `in_reply_to` was given — there's no one to send to.
  | { ok: false; reason: "need_recipient" }
  // The email's owner closed out-of-band reach (requests-only) — the one case
  // an email doesn't resolve (every other address provisions on demand).
  | { ok: false; reason: "email_unreachable"; query: string }
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
    if (to.signPub !== ctx.me.signPub) {
      const row = {
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
      };
      insertMessage(ctx.cache, row);
      ctx.onHistoryAppend?.(row);
    }
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

// ---- group chats (GROUPS: 0.24) -------------------------------------------
// A group is client-side only: a group message is N individually-sealed 1:1
// sends whose envelopes carry the same {id, name, mid, roster}; receivers
// cohere the copies into one thread by group id and store each message under
// the shared mid. The server never learns a group exists.

// The name a person is called BY THE GROUP (rosters + control texts travel to
// every member): their broadcast self-name when known, falling back to the
// local label. Never presented as the user's private nick to others on purpose
// — for auto-saved contacts the two are the same string anyway.
function shareName(c: { selfName?: string; name: string }): string {
  return cleanName(c.selfName) || c.name;
}

// How a group member is shown to the LOCAL user: their nick wins, as everywhere.
function memberLabel(ctx: NetContext, m: GroupMember): string {
  return contactByKey(ctx.book, m.signPub)?.name ?? m.name ?? `${m.signPub.slice(0, 8)}…`;
}

function persistBook(ctx: NetContext): void {
  if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  ctx.onBookChange?.();
}

// "Niels, Tobias & Mette" — the default name for a group made by a
// multi-recipient send. Built from the members' shareNames (it travels).
function autoGroupName(members: GroupMember[]): string {
  const firsts = members.map((m) => (m.name ?? "").split(/\s+/)[0] || m.signPub.slice(0, 6));
  const name = firsts.length > 1
    ? `${firsts.slice(0, -1).join(", ")} & ${firsts[firsts.length - 1]}`
    : firsts[0] ?? "group";
  return cleanName(name) || "group";
}

// Fan one sealed message out to every member (plus any extraRecipients — the
// remove op's final notice to the removed person). One local row is stored
// under the shared mid, born read, so the user's own group sends never surface
// as inbox mail. Partial delivery is reported, not fatal: `failed` carries the
// members whose POST failed; only a total failure throws.
async function sendGroupSealed(
  ctx: NetContext,
  group: Group,
  body: string,
  opts: { in_reply_to?: string | null; asAssistant?: boolean; op?: GroupOp; extraRecipients?: GroupMember[] } = {},
): Promise<{ mid: string; failed: string[] }> {
  const asAssistant = opts.asAssistant === true;
  const text = asAssistant ? body + assistantMark(ctx.me) : body;
  const mid = randomUUID();
  const createdAt = ctx.now();
  // The wire roster: full membership including me — EXCEPT a leave, where my
  // absence from the roster IS the message (receivers rebuild members from it).
  const meEntry = { name: cleanName(ctx.me.name) || undefined, signPub: ctx.me.signPub, boxPub: ctx.me.boxPub };
  const roster = [
    ...(opts.op === "leave" ? [] : [meEntry]),
    ...group.members.map((m) => ({ name: m.name || undefined, signPub: m.signPub, boxPub: m.boxPub })),
  ];
  const wireGroup: WireGroup = { id: group.id, name: group.name, mid, roster, ...(opts.op ? { op: opts.op } : {}) };
  const sealedBody = packBody(ctx.me, text, { assistant: asAssistant, group: wireGroup });
  const recipients = [...group.members, ...(opts.extraRecipients ?? [])];
  const failed: string[] = [];
  let firstError: unknown;
  for (const m of recipients) {
    try {
      await ctx.client.send({
        id: randomUUID(), // transport id — the server keys on it; the message IS `mid`
        recipient: m.signPub,
        sender: ctx.me.signPub,
        body: seal(sealedBody, m.boxPub),
        tags: null,
        created_at: createdAt,
        in_reply_to: opts.in_reply_to ?? null,
      });
    } catch (e) {
      firstError ??= e;
      failed.push(memberLabel(ctx, m));
    }
  }
  if (recipients.length && failed.length === recipients.length) throw firstError;
  try {
    const row: MessageRow = {
      id: mid,
      recipient: group.id,
      sender: ctx.me.signPub,
      body: text,
      tags: null,
      created_at: createdAt,
      fetched_at: createdAt,
      read_at: createdAt,
      in_reply_to: opts.in_reply_to ?? null,
      answered_by: asAssistant ? "assistant" : null,
      group_id: group.id,
      group_name: group.name,
    };
    insertMessage(ctx.cache, row);
    ctx.onHistoryAppend?.(row);
  } catch {
    /* cache hiccup — the sends already went */
  }
  threadAppend(ctx, { name: group.name, signPub: group.id }, { direction: "out", who: "me", body: text, at: createdAt, assistant: asAssistant });
  return { mid, failed };
}

// The success shape every group send returns (multi-recipient send_message,
// a send addressed to a group name, a group reply, and the group tool's ops).
// `to` mirrors the 1:1 result shape (name = the group's name, signPub = its id)
// so shared call sites keep working; `group` is the real signal.
export interface GroupSendOk {
  ok: true;
  id: string;
  to: { name: string; signPub: string; keyChanged?: boolean };
  group: { id: string; name: string; members: string[]; created?: boolean };
  failed?: string[];
  saved?: undefined;
  self?: undefined;
  acceptedHandle?: undefined;
  email?: undefined;
}

function groupSendOk(ctx: NetContext, group: Group, mid: string, failed: string[], created = false): GroupSendOk {
  return {
    ok: true,
    id: mid,
    to: { name: group.name, signPub: group.id },
    group: {
      id: group.id,
      name: group.name,
      members: group.members.map((m) => memberLabel(ctx, m)),
      ...(created ? { created: true } : {}),
    },
    ...(failed.length ? { failed } : {}),
  };
}

// Send to a saved group by name — the single-recipient send path consults this
// when no contact matches, so "write project-x: shipped" just works.
async function sendToGroup(
  ctx: NetContext,
  group: Group,
  body: string,
  asAssistant: boolean,
): Promise<SendResult> {
  if (group.left) return { ok: false, reason: "left_group", query: group.name };
  const { mid, failed } = await sendGroupSealed(ctx, group, body, { asAssistant });
  return groupSendOk(ctx, group, mid, failed);
}

// Multi-recipient send ("write Niels, Tobias and Mette: hey"): GROUP CHAT IS
// THE DEFAULT — reuse the group with exactly this membership, or create one.
// Every name must be a saved contact with keys; failures report per name.
async function sendToNames(
  ctx: NetContext,
  names: string[],
  body: string,
  asAssistant: boolean,
): Promise<SendResult> {
  const picked: Contact[] = [];
  for (const n of names) {
    const r = resolve(ctx.book, n);
    if (r.status === "none") return { ok: false, reason: "no_contact", query: n };
    if (r.status === "ambiguous")
      return { ok: false, reason: "ambiguous", query: n, candidates: r.candidates.map((c) => c.name) };
    if (!r.contact.signPub || !r.contact.boxPub) return { ok: false, reason: "no_keys", query: n };
    if (r.contact.signPub === ctx.me.signPub) continue; // the user in their own list — the group has them anyway
    if (!picked.some((c) => c.signPub === r.contact.signPub)) picked.push(r.contact);
  }
  if (picked.length === 0) return { ok: false, reason: "need_recipient" };
  if (picked.length === 1) {
    // One distinct person after dedupe — an ordinary 1:1 send, no group.
    const c = picked[0]!;
    const accepted = !!c.gated;
    if (c.gated) acceptGatedContact(ctx, c);
    const id = await sendSealed(ctx, { name: c.name, signPub: c.signPub!, boxPub: c.boxPub! }, body, null, asAssistant);
    return { ok: true, id, to: { name: c.name, signPub: c.signPub! }, ...(accepted ? { acceptedHandle: true } : {}) };
  }
  // Writing a held handle into a group counts as accepting, same as a 1:1 send.
  for (const c of picked) if (c.gated) acceptGatedContact(ctx, c);
  const keys = picked.map((c) => c.signPub!).sort();
  const existing = (ctx.book.groups ?? []).find(
    (g) =>
      !g.left &&
      g.members.length === keys.length &&
      g.members.map((m) => m.signPub).sort().every((k, i) => k === keys[i]),
  );
  if (existing) {
    const { mid, failed } = await sendGroupSealed(ctx, existing, body, { asAssistant });
    return groupSendOk(ctx, existing, mid, failed);
  }
  const members: GroupMember[] = picked.map((c) => ({ name: shareName(c), signPub: c.signPub!, boxPub: c.boxPub! }));
  const group: Group = { id: newGroupId(), name: autoGroupName(members), members, createdAt: ctx.now() };
  (ctx.book.groups ??= []).push(group);
  persistBook(ctx);
  // The user's text IS the first message; op:"create" marks it as the birth.
  const { mid, failed } = await sendGroupSealed(ctx, group, body, { asAssistant, op: "create" });
  return groupSendOk(ctx, group, mid, failed, true);
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
  args: { to?: string; body: string; key?: string; email?: string; in_reply_to?: string; as_assistant?: boolean },
): Promise<SendResult | ReplyResult> {
  const asAssistant = args.as_assistant === true;
  // A reply: the recipient is definitionally the other side of the replied-to
  // message — inferred from its id, never from a name lookup (`to` is ignored).
  if (args.in_reply_to)
    return sendReply(ctx, { in_reply_to: args.in_reply_to, body: args.body, as_assistant: asAssistant });
  const to = args.to?.trim();
  if (!to) return { ok: false, reason: "need_recipient" };
  // "me"/"myself" always means the user, even if a contact shares the word.
  if (SELF_WORDS.has(to.toLowerCase())) return sendToSelf(ctx, args.body, asAssistant);

  // SEVERAL comma-separated names (GROUPS) → their shared group chat, created on
  // first use. Not when a key/email rides along — those are 1:1 onboarding sends.
  if (!args.key && !args.email) {
    const parts = to.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) return sendToNames(ctx, parts, args.body, asAssistant);
  }

  const r = resolve(ctx.book, to);

  if (r.status === "none") {
    // No contact by that name — a saved GROUP's name also addresses a send
    // ("write project-x: shipped"). Contacts win a name clash; rename the group.
    if (!args.key && !args.email) {
      const g = resolveGroup(ctx.book, to);
      if (g.status === "resolved") return sendToGroup(ctx, g.group, args.body, asAssistant);
      if (g.status === "ambiguous")
        return { ok: false, reason: "ambiguous", query: to, candidates: g.candidates.map((x) => x.name) };
    }
    // No such contact. An EMAIL address reaches anyone (EMAIL-SEND.md): the
    // server answers with the account's keys or provisions an identity on the
    // spot — the sender can't tell which ("sent" either way), and the first-ever
    // provision of an address triggers the once-ever invite email server-side.
    // The address may arrive as `email`, as `key` ("write Sam at sam@gmail.com"), or
    // as `to` itself ("write sam@gmail.com: hey").
    const emailAddr =
      (args.email?.trim() && EMAIL_ADDR_RE.test(args.email.trim()) ? args.email.trim() : undefined) ??
      (args.key?.trim() && EMAIL_ADDR_RE.test(args.key.trim()) ? args.key.trim() : undefined) ??
      (EMAIL_ADDR_RE.test(to) ? to : undefined);
    if (emailAddr) {
      const addr = emailAddr.toLowerCase();
      const keys = await ctx.client.resolveEmail(addr);
      if (!keys) return { ok: false, reason: "email_unreachable", query: addr };
      // The address resolved to the user's own account → self-send, never self-save.
      if (keys.signPub === ctx.me.signPub) return sendToSelf(ctx, args.body, asAssistant);
      const name = EMAIL_ADDR_RE.test(to) ? (cleanName(to.split("@")[0]!) || to) : to;
      rememberContact(ctx, { name, signPub: keys.signPub, boxPub: keys.boxPub, email: addr });
      const id = await sendSealed(ctx, { name, ...keys }, args.body, null, asAssistant);
      return { ok: true, id, to: { name, signPub: keys.signPub }, saved: true, email: addr };
    }
    // If the user supplied a key code or handle, resolve it,
    // remember them under the name they gave, and send.
    if (args.key) {
      if (!parseKey(args.key) && !isHandle(args.key))
        return { ok: false, reason: "bad_key", query: to };
      const keys = await resolveCode(ctx, args.key);
      if (!keys) return { ok: false, reason: "bad_key", query: to };
      // The code resolved to the user's own identity → self-send, never self-save.
      if (keys.signPub === ctx.me.signPub) return sendToSelf(ctx, args.body, asAssistant);
      rememberContact(ctx, { name: to, signPub: keys.signPub, boxPub: keys.boxPub, handle: keys.handle });
      const id = await sendSealed(ctx, { name: to, ...keys }, args.body, null, asAssistant);
      return { ok: true, id, to: { name: to, signPub: keys.signPub }, saved: true };
    }
    // The user's own name/handle (no contact shadows it, since resolve came up
    // empty) → self-send.
    const q = to.toLowerCase();
    if ((ctx.me.name && q === ctx.me.name.toLowerCase()) || (ctx.me.handle && q === ctx.me.handle.toLowerCase()))
      return sendToSelf(ctx, args.body, asAssistant);
    // Not a saved contact. Before failing, check the second-degree network: if the
    // name matches a friend-of-friend, they're name-only (not messageable yet), so
    // steer to a connect request rather than a dead "no_contact" (FRIENDS.md).
    const fof = await matchNetwork(ctx, to);
    if (fof) return fof;
    return { ok: false, reason: "no_contact", query: to };
  }
  if (r.status === "ambiguous")
    return {
      ok: false,
      reason: "ambiguous",
      query: to,
      candidates: r.candidates.map((c) => c.name),
    };
  const c = r.contact;
  if (!c.signPub || !c.boxPub) {
    // A save-by-email placeholder (addContact): keys ride the first real write.
    // Resolving now is also what triggers a non-user's once-ever invite email
    // server-side — exactly as if this send had carried the address itself.
    if (c.email) {
      const keys = await ctx.client.resolveEmail(c.email);
      if (!keys) return { ok: false, reason: "email_unreachable", query: c.email };
      // The address resolved to the user's own account → self-send, never self-save.
      if (keys.signPub === ctx.me.signPub) return sendToSelf(ctx, args.body, asAssistant);
      rememberContact(ctx, { name: c.name, signPub: keys.signPub, boxPub: keys.boxPub, email: c.email });
      const id = await sendSealed(ctx, { name: c.name, signPub: keys.signPub, boxPub: keys.boxPub }, args.body, null, asAssistant);
      return { ok: true, id, to: { name: c.name, signPub: keys.signPub }, email: c.email };
    }
    return { ok: false, reason: "no_keys", query: to };
  }

  // Writing to a gated new handle is consent: the user is addressing them on
  // purpose, so the gate clears exactly as an explicit accept would (their held
  // messages then surface through the normal unread paths).
  const accepted = !!c.gated;
  if (c.gated) acceptGatedContact(ctx, c);
  const id = await sendSealed(ctx, { name: c.name, signPub: c.signPub, boxPub: c.boxPub }, args.body, null, asAssistant);
  return {
    ok: true,
    id,
    to: { name: c.name, signPub: c.signPub, ...(c.keyChangedAt ? { keyChanged: true } : {}) },
    ...(accepted ? { acceptedHandle: true } : {}),
  };
}

export interface InboxMessage {
  id: string;
  from: string;
  body: string;
  at: number;
  in_reply_to: string | null;
  // Self-mail marker (escalate-by-mail / note to self): from the user's OWN
  // identity. Never auto-tagged or auto-answered.
  self?: boolean;
  // "assistant" when the sender's agent wrote it (renders as "<name>'s assistant").
  answered_by?: string;
  // Group chats (GROUPS): present when the message belongs to a group — the
  // feed renders the sender line as `📨 **<sender> → #<group>**`, and a reply
  // to its id fans to the whole roster.
  group?: { id: string; name: string };
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
    ...(m.group_id ? { group: { id: m.group_id, name: m.group_name ?? "group" } } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

// The new-handle gate state of a row's sender ("pending" / "dismissed") —
// undefined for self-mail and for every accepted or manually-saved contact.
// This is THE filter every model-facing read path applies (0.18): a gated
// sender's bodies stay out of the model's context entirely until the user
// accepts them (the requests tool's accept returns the held batch).
function gateOf(ctx: NetContext, sender: string): "pending" | "dismissed" | undefined {
  if (sender === ctx.me.signPub) return undefined;
  return contactByKey(ctx.book, sender)?.gated;
}

// The "new handles" summary model-facing tools return INSTEAD of gated bodies:
// who is held (name + handle) and how many messages, never the content.
export interface NewHandle {
  name: string;
  handle: string | null;
  count: number;
}

export function pendingHandles(ctx: NetContext): NewHandle[] {
  const by = new Map<string, NewHandle>();
  for (const m of unreadFor(ctx.cache, ctx.me.signPub)) {
    if (gateOf(ctx, m.sender) !== "pending") continue;
    const c = contactByKey(ctx.book, m.sender);
    const cur = by.get(m.sender) ?? {
      name: c?.name ?? `${m.sender.slice(0, 8)}…`,
      handle: c?.handle ?? null,
      count: 0,
    };
    cur.count++;
    by.set(m.sender, cur);
  }
  return [...by.values()];
}

// Take every currently-unread message, marking each read, with the FULL body —
// the receive shape `read_messages` hands straight to the user when there's no fresh
// warmer snapshot. Kept here (not inlined in the tool) so it shares the
// sender-labelling and read semantics with the rest of the receive path instead
// of the tool reaching into the cache directly. Gated senders' rows are skipped
// AND left unread — they're held for the user's accept, not consumed.
export function takeUnread(ctx: NetContext): InboxMessage[] {
  return unreadFor(ctx.cache, ctx.me.signPub)
    .filter((m) => !gateOf(ctx, m.sender))
    .map((m) => {
      markRead(ctx.cache, m.id, ctx.now());
      return toInboxMessage(ctx, m);
    });
}

// ---- pending snapshot: the warmer→waker channel (PUSH.md / db.ts cross-process) ----
// The waker can't safely open inbox.db while the warmer holds it (the wasm
// driver's cross-process lock — the old "mail never surfaced" bug). So the warmer
// (sole writer) mirrors current unread mail here, already decrypted, and the waker
// just watches it. Read-state stays in SQLite; a message is marked read ONLY once a
// consumer acks it (writePendingAck → refreshPending), never at queue time — so
// read_messages and messages_available aren't starved, and nothing is lost if no
// consumer ever runs.

export interface PendingSnapshot {
  writtenAt: number;
  messages: InboxMessage[];
  // Unread messages from GATED ("pending") new handles, kept OUT of `messages` so
  // no model-facing consumer ever returns their bodies: the waker wakes on them
  // once (so the feed can show the 🆕 summary), and read_messages reports only a
  // name+handle+count summary. Never acked/marked read from here — they stay
  // held until the user accepts (requests accept) or goes public. Dismissed
  // handles' messages appear in NEITHER list (silent by design).
  gated?: InboxMessage[];
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

// Consumer side: the ids already surfaced (so they aren't re-announced in the
// window before the warmer applies the ack). Missing/corrupt file → none.
export function readAck(ackPath: string): string[] {
  try {
    const ids = JSON.parse(readFileSync(ackPath, "utf8"));
    return Array.isArray(ids) ? (ids as string[]) : [];
  } catch {
    return [];
  }
}

// Consumer side: read the warmer's snapshot (null when absent/corrupt → fall back
// to a direct drain, which is safe precisely because no warmer is holding the file).
export function readPending(pendingPath: string): PendingSnapshot | null {
  try {
    const snap = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingSnapshot;
    if (snap && Array.isArray(snap.messages) && typeof snap.writtenAt === "number") return snap;
  } catch {
    /* missing/corrupt — caller falls back */
  }
  return null;
}

// Consumer side: record the ids surfaced this run (overwrite — always the current
// pending set, so it never grows unbounded). The warmer applies it on its next tick.
export function writePendingAck(ackPath: string, ids: string[]): void {
  writeJsonAtomic(ackPath, ids);
}

// ---- chat.lock: the live-chat heartbeat + its mode flag ----
// Written by the waker (await-mail.ts touchLock) every tick; read here so every
// process agrees on "is a chat session live, and is it public". While the lock
// is fresh the inbox rider stays silent (the feed owns surfacing), and `public`
// — the new-handle gate's per-session bypass (0.18) — makes sync() auto-save
// new senders ungated.

export const CHAT_ACTIVE_MS = 15_000; // > the waker's tick cadence, covers relaunch gap

export interface ChatLockInfo {
  active: boolean;
  public: boolean;
}

export function readChatLock(lockPath: string, nowMs: number): ChatLockInfo {
  try {
    if (nowMs - statSync(lockPath).mtimeMs >= CHAT_ACTIVE_MS)
      return { active: false, public: false };
    let pub = false;
    try {
      pub = (JSON.parse(readFileSync(lockPath, "utf8")) as { public?: boolean })?.public === true;
    } catch {
      /* older lock content (a bare timestamp) → plain chat */
    }
    return { active: true, public: pub };
  } catch {
    return { active: false, public: false }; // no lock → chat isn't running
  }
}

// The gated ids a given side has already handled (the waker's wake dedup + the
// hook's shown-to-user dedup). Same overwrite semantics as the ack file: always
// rewritten with the CURRENT gated set, so they never grow.
export function readIdList(path: string): string[] {
  try {
    const ids = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(ids) ? (ids as string[]) : [];
  } catch {
    return [];
  }
}

export function writeIdList(path: string, ids: string[]): void {
  writeJsonAtomic(path, ids);
}

// Warmer side: apply any acked ids (mark them read so they drop out), then
// mirror the remaining unread set to pendingPath. The ONLY writer of pendingPath.
export function refreshPending(
  ctx: NetContext,
  pendingPath: string,
  ackPath: string,
  synced = true,
): void {
  for (const id of readAck(ackPath)) markRead(ctx.cache, id, ctx.now());
  const rows = unreadFor(ctx.cache, ctx.me.signPub);
  const messages: InboxMessage[] = rows
    .filter((m) => !gateOf(ctx, m.sender))
    .map((m) => toInboxMessage(ctx, m));
  const gated: InboxMessage[] = rows
    .filter((m) => gateOf(ctx, m.sender) === "pending")
    .map((m) => toInboxMessage(ctx, m));
  writeJsonAtomic(pendingPath, {
    writtenAt: ctx.now(),
    messages,
    ...(gated.length ? { gated } : {}),
    synced,
  } satisfies PendingSnapshot);
}

export interface AvailableResult {
  count: number;
  messages: { id: string; from: string; preview: string; at: number; group?: string }[];
  // Held new handles (gate pending): name + handle + message count, NO bodies —
  // those are shown to the user by the system, never through the model.
  new_handles?: NewHandle[];
}

export async function messagesAvailable(ctx: NetContext): Promise<AvailableResult> {
  await sync(ctx);
  const rows = unreadFor(ctx.cache, ctx.me.signPub).filter((m) => !gateOf(ctx, m.sender));
  const held = pendingHandles(ctx);
  return {
    count: rows.length,
    messages: rows.map((m) => ({
      id: m.id,
      from: labelForRow(ctx, m),
      preview: m.body.length > 200 ? m.body.slice(0, 197) + "..." : m.body,
      at: m.created_at,
      ...(m.group_id ? { group: m.group_name ?? "group" } : {}),
    })),
    ...(held.length ? { new_handles: held } : {}),
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
      group?: { id: string; name: string };
    }
  | { ok: false; reason: "empty" | "not_found" }
  // The message is from a gated new handle: the body stays held (shown to the
  // user by the system only) until they accept via the requests tool.
  | { ok: false; reason: "new_handle"; name: string; handle: string | null };

export async function readMessage(ctx: NetContext, args: { id?: string }): Promise<ReadResult> {
  await sync(ctx);
  let row: MessageRow | undefined;
  if (args.id) {
    row = getMessage(ctx.cache, args.id);
    if (!row || row.recipient !== ctx.me.signPub) return { ok: false, reason: "not_found" };
    if (gateOf(ctx, row.sender)) {
      const c = contactByKey(ctx.book, row.sender);
      return {
        ok: false,
        reason: "new_handle",
        name: c?.name ?? `${row.sender.slice(0, 8)}…`,
        handle: c?.handle ?? null,
      };
    }
  } else {
    row = unreadFor(ctx.cache, ctx.me.signPub).filter((m) => !gateOf(ctx, m.sender))[0];
    if (!row) return { ok: false, reason: "empty" };
  }
  markRead(ctx.cache, row.id, ctx.now());
  return { ok: true, ...toInboxMessage(ctx, row) };
}

// ---- the new-handle gate: accept / dismiss (0.18) -------------------------

export type HandleResponse =
  | { ok: true; action: "accept"; name: string; handle: string | null; count: number; messages: InboxMessage[] }
  | { ok: true; action: "dismiss"; name: string; handle: string | null; held: number }
  | { ok: false; reason: "no_match"; query: string }
  | { ok: false; reason: "ambiguous"; query: string; candidates: string[] };

// Clear the gate on a held contact: they become a normal (auto-saved) contact,
// their edge joins the second-degree graph, and the change syncs like any other
// book write. Shared by respondHandle, the accept-on-write path (sendMessage /
// sendReply) and the public-mode backlog sweep (server-net chatBatch).
export function acceptGatedContact(ctx: NetContext, c: Contact): void {
  delete c.gated;
  if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
  if (c.signPub) ctx.onEdgeAdd?.(c.signPub);
  ctx.onBookChange?.();
}

// Resolve a gated handle by name / self-name / 6-char handle (exact match first,
// then substring — same spirit as resolve()) and accept or dismiss it.
// accept → the held messages are marked read and RETURNED (the user just
// approved them for the feed). dismiss → stays quiet: later messages from them
// accumulate silently until a future accept.
export function respondHandle(
  ctx: NetContext,
  args: { name: string; action: "accept" | "dismiss" },
): HandleResponse {
  const q = args.name.trim().toLowerCase();
  const pool = ctx.book.contacts.filter((c) => c.gated);
  const namesOf = (c: Contact) =>
    [c.name, c.selfName, c.handle].filter((n): n is string => !!n).map((n) => n.toLowerCase());
  let matches = q ? pool.filter((c) => namesOf(c).includes(q)) : [];
  if (!matches.length && q) matches = pool.filter((c) => namesOf(c).some((n) => n.includes(q)));
  if (!matches.length) return { ok: false, reason: "no_match", query: args.name };
  if (matches.length > 1)
    return {
      ok: false,
      reason: "ambiguous",
      query: args.name,
      candidates: matches.map((c) => `${c.name}${c.handle ? ` (${c.handle})` : ""}`),
    };
  const c = matches[0]!;
  const held = unreadFor(ctx.cache, ctx.me.signPub).filter((m) => m.sender === c.signPub);
  if (args.action === "dismiss") {
    c.gated = "dismissed";
    if (ctx.contactsPath) saveContacts(ctx.contactsPath, ctx.book);
    ctx.onBookChange?.();
    return { ok: true, action: "dismiss", name: c.name, handle: c.handle ?? null, held: held.length };
  }
  acceptGatedContact(ctx, c);
  const messages = held.map((m) => {
    markRead(ctx.cache, m.id, ctx.now());
    return toInboxMessage(ctx, m);
  });
  return { ok: true, action: "accept", name: c.name, handle: c.handle ?? null, count: messages.length, messages };
}

export type ReplyResult =
  | { ok: true; id: string; to: { name: string; signPub: string; keyChanged?: boolean }; self?: boolean; acceptedHandle?: boolean; group?: undefined }
  // Replying to a group message fans to the whole roster (reply-all is the
  // group semantic) and reports the group, not a single recipient.
  | GroupSendOk
  | { ok: false; reason: "not_found" | "no_keys" }
  | { ok: false; reason: "left_group"; query: string };

// The reply half of sendMessage: recipient inferred from the replied-to message,
// so a reply can never be misdirected by a name lookup. Internal — the public
// door is sendMessage({ in_reply_to }).
async function sendReply(
  ctx: NetContext,
  args: { in_reply_to: string; body: string; as_assistant?: boolean },
): Promise<ReplyResult> {
  const original = getMessage(ctx.cache, args.in_reply_to);
  if (!original) return { ok: false, reason: "not_found" };
  const asAssistant = args.as_assistant === true;

  // A group message: the reply goes to the WHOLE roster — reply-all is the
  // group semantic (a private aside is a fresh 1:1 send, never a reply id).
  if (original.group_id) {
    const grp = groupById(ctx.book, original.group_id);
    if (grp?.left) return { ok: false, reason: "left_group", query: grp.name };
    if (grp) {
      const { mid, failed } = await sendGroupSealed(ctx, grp, args.body, {
        in_reply_to: original.id,
        asAssistant,
      });
      return groupSendOk(ctx, grp, mid, failed);
    }
    // Group unknown locally (e.g. the message predates this device's book) —
    // fall through to a plain 1:1 reply to the sender below.
  }

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

  // Replying to a gated handle's message = consent, same as writing them fresh.
  const accepted = !!c.gated;
  if (c.gated) acceptGatedContact(ctx, c);
  const id = await sendSealed(
    ctx,
    { name: c.name, signPub: c.signPub, boxPub: c.boxPub },
    args.body,
    original.id,
    asAssistant,
  );
  const kc = contactByKey(ctx.book, c.signPub)?.keyChangedAt;
  return {
    ok: true,
    id,
    to: { name: c.name, signPub: c.signPub, ...(kc ? { keyChanged: true } : {}) },
    ...(accepted ? { acceptedHandle: true } : {}),
  };
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
        group?: string; // the group's name, when the row is group traffic
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
  let group: Group | null = null;
  if (args.with?.trim()) {
    const r = resolve(ctx.book, args.with);
    if (r.status === "ambiguous")
      return {
        ok: false,
        reason: "ambiguous",
        query: args.with,
        candidates: r.candidates.map((c) => c.name),
      };
    if (r.status === "resolved" && r.contact.signPub) {
      other = r.contact;
    } else {
      // Not a (keyed) contact — a GROUP's name also names a thread.
      const gr = resolveGroup(ctx.book, args.with);
      if (gr.status === "resolved") group = gr.group;
      else if (gr.status === "ambiguous")
        return { ok: false, reason: "ambiguous", query: args.with, candidates: gr.candidates.map((g) => g.name) };
      else return { ok: false, reason: "no_contact", query: args.with };
    }
  }
  const rows = historyRows(ctx.cache, ctx.me.signPub, other?.signPub ?? null, {
    limit: args.limit,
    before: args.before,
    q: args.q,
    ...(group ? { group: group.id } : {}),
  });
  return {
    ok: true,
    with: group?.name ?? other?.name ?? null,
    messages: rows.map((r) => ({
      id: r.id,
      direction: r.sender === ctx.me.signPub ? ("out" as const) : ("in" as const),
      who: r.sender === ctx.me.signPub ? "me" : labelForRow(ctx, r),
      body: r.body,
      at: r.created_at,
      in_reply_to: r.in_reply_to,
      ...(r.answered_by ? { answered_by: r.answered_by } : {}),
      ...(r.group_id ? { group: r.group_name ?? "group" } : {}),
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

// --- group management (GROUPS: 0.24) — the `group` tool's operations --------
// Membership changes are ordinary group messages carrying an `op` + the updated
// roster: every member (including a newcomer, including the person removed)
// hears about the change as a message in the thread, and the roster it rides on
// IS the update. No server involvement.

export type GroupManageResult =
  | (GroupSendOk & { action: string })
  | { ok: true; action: "list"; groups: { id: string; name: string; members: string[]; left?: boolean }[] }
  | { ok: true; action: "leave"; group: { id: string; name: string; members: string[] }; already?: boolean; failed?: string[] }
  | {
      ok: false;
      reason:
        | "no_group"
        | "ambiguous"
        | "no_contact"
        | "ambiguous_member"
        | "no_keys"
        | "need_members"
        | "need_name"
        | "already_member"
        | "not_member"
        | "left_group"
        | "too_many";
      action: string;
      query?: string;
      candidates?: string[];
    };

function groupSummary(ctx: NetContext, g: Group): { id: string; name: string; members: string[]; left?: boolean } {
  return {
    id: g.id,
    name: g.name,
    members: g.members.map((m) => memberLabel(ctx, m)),
    ...(g.left ? { left: true } : {}),
  };
}

export function listGroups(ctx: NetContext): Extract<GroupManageResult, { action: "list" }> {
  return { ok: true, action: "list", groups: (ctx.book.groups ?? []).map((g) => groupSummary(ctx, g)) };
}

// Create a group explicitly ("make a group with Niels and Tobias called
// project-x"). `body` becomes the first message; without one, the birth notice
// is the message. (The multi-recipient send path creates groups implicitly —
// this is the door for a named creation.)
export async function createGroup(
  ctx: NetContext,
  args: { members: string[]; name?: string; body?: string; as_assistant?: boolean },
): Promise<GroupManageResult> {
  const names = (args.members ?? []).map((n) => n.trim()).filter(Boolean);
  if (!names.length) return { ok: false, reason: "need_members", action: "create" };
  const picked: Contact[] = [];
  for (const n of names) {
    const r = resolve(ctx.book, n);
    if (r.status === "none") return { ok: false, reason: "no_contact", action: "create", query: n };
    if (r.status === "ambiguous")
      return { ok: false, reason: "ambiguous", action: "create", query: n, candidates: r.candidates.map((c) => c.name) };
    if (!r.contact.signPub || !r.contact.boxPub) return { ok: false, reason: "no_keys", action: "create", query: n };
    if (r.contact.signPub === ctx.me.signPub) continue;
    if (!picked.some((c) => c.signPub === r.contact.signPub)) picked.push(r.contact);
  }
  if (!picked.length) return { ok: false, reason: "need_members", action: "create" };
  if (picked.length > GROUP_MAX_MEMBERS) return { ok: false, reason: "too_many", action: "create" };
  for (const c of picked) if (c.gated) acceptGatedContact(ctx, c); // adding = consenting, like writing them
  const members: GroupMember[] = picked.map((c) => ({ name: shareName(c), signPub: c.signPub!, boxPub: c.boxPub! }));
  const group: Group = {
    id: newGroupId(),
    name: cleanName(args.name ?? "").replace(/^#/, "") || autoGroupName(members),
    members,
    createdAt: ctx.now(),
  };
  (ctx.book.groups ??= []).push(group);
  persistBook(ctx);
  const myName = cleanName(ctx.me.name) || "someone";
  const text = args.body?.trim() || `${myName} started the group "${group.name}"`;
  const { mid, failed } = await sendGroupSealed(ctx, group, text, { op: "create", asAssistant: args.as_assistant === true });
  return { ...groupSendOk(ctx, group, mid, failed, true), action: "create" };
}

// Add / remove a member, rename the group, or leave it. Flat membership by
// design (v1): any member may change the roster — like the chat itself, the
// group runs on cooperation, and every change is announced in the thread.
export async function manageGroup(
  ctx: NetContext,
  args: { group: string; action: "add" | "remove" | "rename" | "leave"; name?: string; as_assistant?: boolean },
): Promise<GroupManageResult> {
  const action = args.action;
  const gr = resolveGroup(ctx.book, args.group ?? "");
  if (gr.status === "none") return { ok: false, reason: "no_group", action, query: args.group };
  if (gr.status === "ambiguous")
    return { ok: false, reason: "ambiguous", action, query: args.group, candidates: gr.candidates.map((g) => g.name) };
  const group = gr.group;
  const myName = cleanName(ctx.me.name) || "someone";
  const asAssistant = args.as_assistant === true;

  if (action === "leave") {
    if (group.left) return { ok: true, action: "leave", group: groupSummary(ctx, group), already: true };
    // Announce first (the roster on the leave message excludes the leaver — that
    // IS the update), then flip the local flag.
    const { failed } = await sendGroupSealed(ctx, group, `${myName} left the group "${group.name}"`, {
      op: "leave",
      asAssistant,
    });
    group.left = true;
    persistBook(ctx);
    return { ok: true, action: "leave", group: groupSummary(ctx, group), ...(failed.length ? { failed } : {}) };
  }

  if (group.left) return { ok: false, reason: "left_group", action, query: group.name };

  if (action === "rename") {
    const name = cleanName(args.name ?? "").replace(/^#/, "");
    if (!name) return { ok: false, reason: "need_name", action };
    const old = group.name;
    group.name = name;
    persistBook(ctx);
    const { mid, failed } = await sendGroupSealed(ctx, group, `${myName} renamed the group "${old}" to "${name}"`, {
      op: "rename",
      asAssistant,
    });
    return { ...groupSendOk(ctx, group, mid, failed), action };
  }

  if (action === "add") {
    if (!args.name?.trim()) return { ok: false, reason: "need_name", action };
    const r = resolve(ctx.book, args.name);
    if (r.status === "none") return { ok: false, reason: "no_contact", action, query: args.name };
    if (r.status === "ambiguous")
      return { ok: false, reason: "ambiguous", action, query: args.name, candidates: r.candidates.map((c) => c.name) };
    const c = r.contact;
    if (!c.signPub || !c.boxPub) return { ok: false, reason: "no_keys", action, query: args.name };
    if (group.members.some((m) => m.signPub === c.signPub))
      return { ok: false, reason: "already_member", action, query: c.name };
    if (group.members.length + 1 > GROUP_MAX_MEMBERS) return { ok: false, reason: "too_many", action };
    if (c.gated) acceptGatedContact(ctx, c);
    group.members.push({ name: shareName(c), signPub: c.signPub, boxPub: c.boxPub });
    persistBook(ctx);
    const { mid, failed } = await sendGroupSealed(
      ctx,
      group,
      `${myName} added ${shareName(c)} to the group "${group.name}"`,
      { op: "add", asAssistant },
    );
    return { ...groupSendOk(ctx, group, mid, failed), action };
  }

  // remove: match the member by the user's nick or their roster name; the
  // removed person still gets the announcement as a final notice.
  if (!args.name?.trim()) return { ok: false, reason: "need_name", action };
  const q = args.name.trim().toLowerCase();
  const labelsOf = (m: GroupMember) =>
    [memberLabel(ctx, m), m.name].filter(Boolean).map((s) => s!.toLowerCase());
  let hits = group.members.filter((m) => labelsOf(m).some((l) => l === q));
  if (!hits.length) hits = group.members.filter((m) => labelsOf(m).some((l) => l.includes(q)));
  if (!hits.length) return { ok: false, reason: "not_member", action, query: args.name };
  if (hits.length > 1)
    return { ok: false, reason: "ambiguous_member", action, query: args.name, candidates: hits.map((m) => memberLabel(ctx, m)) };
  const removed = hits[0]!;
  group.members = group.members.filter((m) => m.signPub !== removed.signPub);
  persistBook(ctx);
  const { mid, failed } = await sendGroupSealed(
    ctx,
    group,
    `${myName} removed ${removed.name || memberLabel(ctx, removed)} from the group "${group.name}"`,
    { op: "remove", asAssistant, extraRecipients: [removed] },
  );
  return { ...groupSendOk(ctx, group, mid, failed), action };
}
