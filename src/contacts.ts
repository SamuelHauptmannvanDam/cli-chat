// Phase 0 contact book: a flat local JSON file per user + an exact-name
// resolver. No social graph, no learned tags yet (Phase 2/3). Resolution is
// case-insensitive match against the contact's name and any aliases.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { writeSecretAtomic } from "./secure-fs.ts";

// Display names (the user's own, a nickname, a contact's self-name) are capped at
// this many characters. Generous for any real name, but a hard limit so nobody can
// stuff extra data into a name — which matters because a sender's self-name rides
// in EVERY message envelope through the server (payload you pay for per message).
export const NAME_MAX = 128;

// Tags are short, local-only labels ("work", "family") the user/agent attaches to
// a contact. Capped well under a name — they're keywords, not prose.
export const TAG_MAX = 64;

// How a tag came to be on a contact. "manual" = the user asked; "self" = inferred
// from that contact's own messages (2a-ii); "cross" = inferred from the circle they
// cluster with (2a-iii). Stored so cross-inference can weight evidence by origin.
export type TagSource = "manual" | "self" | "cross";

// Cap on evidence tokens kept PER TAG (the signal words behind it, e.g. "standup",
// "sprint"). Bounded so tagMeta can't grow without limit; when full we keep the most
// recent tokens (newer context is the better fingerprint).
export const EVIDENCE_PER_TAG_MAX = 12;

// Normalise a display name before storing it: trim, strip control characters
// (incl. newlines — a self-name from another client is untrusted and shown in the
// terminal), and cap to NAME_MAX. Truncates rather than rejecting, so a too-long
// name is just shortened. Returns "" for empty/whitespace-only input.
export function cleanName(raw: string | undefined | null): string {
  if (!raw) return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, NAME_MAX);
}

// Normalise a tag before storing/matching it: strip control chars, collapse
// internal whitespace, LOWER-CASE (so "Work"/"work" are one tag), trim, cap at
// TAG_MAX. Lower-casing is what makes tag matching case-insensitive and lets the
// agent fold synonyms onto one canonical spelling. "" for empty input.
export function cleanTag(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, TAG_MAX);
}

// Add a tag to a contact (mutates in place). No-op if the tag is empty or already
// present (deduped, case-insensitive via cleanTag). Returns true if it changed.
export function addTag(c: Contact, tag: string): boolean {
  const t = cleanTag(tag);
  if (!t) return false;
  if (!c.tags) c.tags = [];
  if (c.tags.includes(t)) return false;
  c.tags.push(t);
  return true;
}

// Remove a tag from a contact (mutates in place). Returns true if it was present
// and removed. Drops the array entirely when it empties, so a tagless contact has
// no `tags` key rather than `[]`.
export function removeTag(c: Contact, tag: string): boolean {
  const t = cleanTag(tag);
  if (!t || !c.tags) return false;
  const next = c.tags.filter((x) => x !== t);
  if (next.length === c.tags.length) return false;
  if (next.length) c.tags = next;
  else delete c.tags;
  return true;
}

// Record (or merge into) the evidence + provenance behind a tag — the WHY a future
// cross-inference pass matches against. Creates the tagMeta entry on first use; on
// later calls it merges new evidence tokens (normalised + deduped, capped to the most
// recent EVIDENCE_PER_TAG_MAX) and bumps updatedAt. `source` is set once, on create
// — a later automatic merge never downgrades a 'manual' origin. Returns true if
// anything changed (so the caller knows to persist). Independent of addTag: evidence
// accumulates even when the tag itself was already present.
export function recordTagMeta(
  c: Contact,
  tag: string,
  opts: { source: TagSource; evidence?: string[]; now: number },
): boolean {
  const t = cleanTag(tag);
  if (!t) return false;
  if (!c.tagMeta) c.tagMeta = [];
  let entry = c.tagMeta.find((m) => m.tag === t);
  let changed = false;
  if (!entry) {
    entry = { tag: t, source: opts.source, addedAt: opts.now };
    c.tagMeta.push(entry);
    changed = true;
  }
  const incoming = (opts.evidence ?? []).map((e) => cleanTag(e)).filter(Boolean);
  if (incoming.length) {
    const merged = [...(entry.evidence ?? [])];
    for (const tok of incoming) if (!merged.includes(tok)) merged.push(tok);
    const capped =
      merged.length > EVIDENCE_PER_TAG_MAX ? merged.slice(merged.length - EVIDENCE_PER_TAG_MAX) : merged;
    if (capped.join("\n") !== (entry.evidence ?? []).join("\n")) {
      entry.evidence = capped;
      changed = true;
    }
  }
  if (changed) entry.updatedAt = opts.now;
  return changed;
}

// Drop the tagMeta entry for a tag (mutates in place). Returns true if one existed.
// Called when a tag is removed so its evidence doesn't linger as a stale fingerprint.
export function removeTagMeta(c: Contact, tag: string): boolean {
  const t = cleanTag(tag);
  if (!t || !c.tagMeta) return false;
  const next = c.tagMeta.filter((m) => m.tag !== t);
  if (next.length === c.tagMeta.length) return false;
  if (next.length) c.tagMeta = next;
  else delete c.tagMeta;
  return true;
}

// Mark a tag as DECLINED for a contact, so a future cross-inference pass never
// re-suggests it (mutates in place; deduped). Returns true if newly recorded.
export function declineTag(c: Contact, tag: string): boolean {
  const t = cleanTag(tag);
  if (!t) return false;
  if (!c.declinedTags) c.declinedTags = [];
  if (c.declinedTags.includes(t)) return false;
  c.declinedTags.push(t);
  return true;
}

// Whether a tag has been declined for this contact (case-insensitive).
export function isTagDeclined(c: Contact, tag: string): boolean {
  const t = cleanTag(tag);
  return !!t && !!c.declinedTags?.includes(t);
}

// ---- Cross-contact inference (2a-iii-b/c): match a contact against your circles ----

export interface TagSuggestion {
  tag: string; // a tag the contact likely belongs to
  score: number; // confidence score (higher = stronger); must clear the threshold
  shared: string[]; // the candidate signals that matched (topics + mutual names)
}

// Confidence knobs — the "higher bar" for cross-tags. Each shared evidence TOKEN is
// worth a little; a shared mutual-contact NAME is worth more (knowing the same people
// is stronger than sharing a buzzword). A suggestion must clear the THRESHOLD. These
// are the dials 2a-iii-c tunes against real data.
export const CROSS_TOPIC_WEIGHT = 1;
export const CROSS_MUTUAL_WEIGHT = 2;
export const CROSS_SUGGEST_THRESHOLD = 3;
export const CROSS_MAX_SUGGESTIONS = 3;

// Suggest tags for `target` by matching its signals against the evidence fingerprints
// of your ALREADY-tagged contacts (the clusters). Pure + deterministic, so the same
// inputs always score the same. `signals` are extra tokens from the contact's current
// message — topics AND any contact names they mention; the target's own stored
// evidence is folded in too. Returns suggestions clearing CROSS_SUGGEST_THRESHOLD,
// strongest first, excluding tags the target already has or has declined.
export function suggestTagsFor(
  book: ContactBook,
  target: Contact,
  signals: string[] = [],
): TagSuggestion[] {
  // Candidate signal set: current-message tokens + the target's own stored evidence.
  const candidate = new Set<string>();
  for (const s of signals) {
    const t = cleanTag(s);
    if (t) candidate.add(t);
  }
  for (const m of target.tagMeta ?? []) for (const e of m.evidence ?? []) candidate.add(e);
  if (candidate.size === 0) return [];

  const have = new Set(target.tags ?? []);
  const declined = new Set(target.declinedTags ?? []);

  // Per-tag fingerprint from every OTHER contact: evidence tokens + member names. A
  // tagged contact contributes their names to all their tags (so a target mentioning
  // them is mutual evidence) and their evidence tokens to the tags they carry.
  const fp = new Map<string, { tokens: Set<string>; names: Set<string> }>();
  const ensure = (tag: string) => {
    let f = fp.get(tag);
    if (!f) {
      f = { tokens: new Set(), names: new Set() };
      fp.set(tag, f);
    }
    return f;
  };
  for (const c of book.contacts) {
    if (c === target || (target.signPub && c.signPub === target.signPub)) continue;
    const names = [c.name, c.selfName, ...(c.aliases ?? [])].map((n) => cleanTag(n ?? "")).filter(Boolean);
    for (const tag of c.tags ?? []) for (const n of names) ensure(tag).names.add(n);
    for (const m of c.tagMeta ?? []) {
      const f = ensure(m.tag);
      for (const e of m.evidence ?? []) f.tokens.add(e);
      for (const n of names) f.names.add(n);
    }
  }

  const out: TagSuggestion[] = [];
  for (const [tag, f] of fp) {
    if (have.has(tag) || declined.has(tag)) continue;
    let score = 0;
    const shared: string[] = [];
    for (const s of candidate) {
      if (f.names.has(s)) {
        score += CROSS_MUTUAL_WEIGHT;
        shared.push(s);
      } else if (f.tokens.has(s)) {
        score += CROSS_TOPIC_WEIGHT;
        shared.push(s);
      }
    }
    if (score >= CROSS_SUGGEST_THRESHOLD) out.push({ tag, score, shared });
  }
  out.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return out.slice(0, CROSS_MAX_SUGGESTIONS);
}

export interface Contact {
  // signPub (below) is the sole identity — there is no separate id. `name` is just
  // a label and may repeat: two different people can both be "Sam", told apart by key.
  name: string; // YOUR nickname for them — what you see in the terminal, e.g. "Niels"
  selfName?: string; // what THEY call themselves (from their message envelopes). Kept
  // separate from your nick so the contacts list can show both, and preserved even
  // after you rename them. Untrusted (another client sets it) → always cleanName'd.
  aliases?: string[]; // alternative spellings the resolver also matches
  signPub?: string; // Phase 1: contact's Ed25519 address (mailbox key)
  boxPub?: string; // Phase 1: contact's X25519 key we seal messages to
  handle?: string; // their shareable 6-char code, when known (carried in their messages)
  verified?: { at: number; boxPub: string }; // the user compared safety numbers out-of-band
  // and confirmed; snapshots the box key that was blessed. Cleared if that key changes.
  keyChangedAt?: number; // epoch ms when a VERIFIED contact's box key changed under the
  // same identity — the safety number no longer holds; warn and suggest re-verifying.
  auto?: boolean; // saved automatically from a received self-introduction, NOT a
  // user-chosen nick. While true, `name` is just what they call themselves, so we
  // show "name (handle)"; renaming them (a real nick) clears this and shows the nick.
  gated?: "pending" | "dismissed"; // the NEW-HANDLE GATE (0.18): a first-time sender
  // is held here instead of flowing into the inbox. Their messages stay out of the
  // model's context (bodies are shown to the USER directly by the system) until the
  // user accepts ("pending" → cleared) — or stays quiet forever once "dismissed".
  // Absent on every real contact; never set by a manual save.
  sentCount?: number; // how many messages YOU'VE sent them; ranks the "most active"
  // shortcut in the contacts list. Absent on contacts never written to (treated 0).
  lastMessageAt?: number; // epoch ms of the last message you sent them (recency tiebreak).
  tags?: string[]; // LOCAL labels you/the agent attach ("work", "family"). Never sent
  // to the server or another client — purely your own view, used for "write everyone
  // from work". Lower-cased + deduped via cleanTag. Absent when untagged.
  tagMeta?: TagMeta[]; // WHY each tag is here (2a-iii): origin + the evidence tokens
  // behind it, so cross-inference can match a new contact against existing circles.
  // Additive to `tags` (which stays the fast membership set). Absent until recorded.
  declinedTags?: string[]; // tags the user rejected for this contact, so a future
  // cross-inference pass never re-suggests them. Lower-cased; absent when none.
}

// The provenance + evidence behind one tag on a contact. Local-only, like tags.
export interface TagMeta {
  tag: string; // the canonical (cleanTag'd) tag this evidence supports
  source: TagSource; // how it was first applied (manual / self / cross)
  evidence?: string[]; // normalised signal tokens that triggered it ("standup", …),
  // deduped and capped to EVIDENCE_PER_TAG_MAX (most recent kept)
  addedAt: number; // epoch ms when the tag was first recorded
  updatedAt?: number; // epoch ms of the last evidence merge, when it has changed since
}

export interface ContactBook {
  me: string; // this user's own id
  contacts: Contact[];
}

export function loadContacts(path: string): ContactBook {
  const raw = readFileSync(path, "utf8");
  const book = JSON.parse(raw) as ContactBook;
  if (!book.me || !Array.isArray(book.contacts)) {
    throw new Error(`Invalid contact book at ${path}: needs { me, contacts[] }`);
  }
  return book;
}

// Persist the book atomically: write a sibling temp file, then rename it over the
// target (atomic on POSIX). The book is written by more than one process — the MCP
// server's push warmer AND the per-prompt session hook both sync() and can auto-save
// a newly-seen sender — so a plain full-file writeFileSync from each could interleave
// and truncate it. Temp-write + rename means a reader always sees a complete file.
export function saveContacts(path: string, book: ContactBook): void {
  writeSecretAtomic(path, JSON.stringify(book, null, 2) + "\n");
}

export type ResolveResult =
  | { status: "resolved"; contact: Contact }
  | { status: "none"; query: string }
  | { status: "ambiguous"; query: string; candidates: Contact[] };

// Map a name → a specific contact. Exact (case-insensitive) match wins outright;
// only when nothing matches exactly do we fall back to a substring/prefix scan,
// so "Niels" still finds the saved "Niels - bankdata". The fallback returns
// `ambiguous` when more than one contact contains the query, so the caller can
// ask which one rather than guessing.
export function resolve(book: ContactBook, query: string): ResolveResult {
  const q = query.trim().toLowerCase();
  const namesOf = (c: Contact) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());

  const exact = book.contacts.filter((c) => namesOf(c).includes(q));
  if (exact.length > 1) return { status: "ambiguous", query, candidates: exact };
  if (exact[0]) return { status: "resolved", contact: exact[0] };

  // No exact hit — try a looser substring match (skip empty queries, which
  // would "contain" into every contact).
  if (!q) return { status: "none", query };
  const fuzzy = book.contacts.filter((c) => namesOf(c).some((n) => n.includes(q)));
  if (fuzzy.length > 1) return { status: "ambiguous", query, candidates: fuzzy };
  if (fuzzy[0]) return { status: "resolved", contact: fuzzy[0] };
  return { status: "none", query };
}

// How recently you must have written someone for them to count as "active". Past
// this they drop out of the active list and rejoin the alphabetical rest, so a
// contact you stop messaging ages off the top on its own.
export const ACTIVE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

// Split the book into two display lists:
//   active — people written within the last 60 days, ordered by who you've written
//            MOST (then recency, then name). Your current conversations, on top.
//   rest   — everyone else (gone quiet, or never written), alphabetical.
// `now` is epoch ms. Pure: returns new arrays, does not mutate the input.
export function orderedContacts(
  contacts: Contact[],
  now: number,
): { active: Contact[]; rest: Contact[] } {
  const cutoff = now - ACTIVE_WINDOW_MS;
  const byName = (a: Contact, b: Contact) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  const active: Contact[] = [];
  const rest: Contact[] = [];
  for (const c of contacts) {
    const ts = c.lastMessageAt ?? 0;
    if (ts > 0 && ts >= cutoff) active.push(c);
    else rest.push(c);
  }
  active.sort(
    (a, b) =>
      (b.sentCount ?? 0) - (a.sentCount ?? 0) ||
      (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
      byName(a, b),
  );
  rest.sort(byName);
  return { active, rest };
}

// Phase 1 reverse lookup keyed by Ed25519 address. Falls back to a short prefix
// of the key for unknown senders.
export function displayNameByKey(book: ContactBook, signPub: string): string {
  const c = book.contacts.find((c) => c.signPub === signPub);
  return c?.name ?? `${signPub.slice(0, 8)}…`;
}

// How a SENDER is shown in the terminal. Your nickname always wins: once you
// have a contact for them, that's all you see — there's a difference between
// what they call themselves and what YOU call them. Only an auto-saved stranger
// (no nick chosen yet) is shown as "name (handle)" so you know who they are and
// can recognise their code; a truly unknown sender falls back to a key prefix.
export function senderLabel(book: ContactBook, signPub: string): string {
  const c = contactByKey(book, signPub);
  if (!c) return `${signPub.slice(0, 8)}…`;
  if (c.auto && c.handle) return `${c.name} (${c.handle})`;
  return c.name;
}

export function contactByKey(book: ContactBook, signPub: string): Contact | undefined {
  return book.contacts.find((c) => c.signPub === signPub);
}

// Drop a contact by key (signPub is the sole identity, so this is exact and can
// only ever remove the one entry). Returns true if a contact was removed, false
// if no entry had that key. Mutates the book in place; the caller persists.
export function removeContactByKey(book: ContactBook, signPub: string): boolean {
  const before = book.contacts.length;
  book.contacts = book.contacts.filter((c) => c.signPub !== signPub);
  return book.contacts.length < before;
}

// Safety number for out-of-band contact verification (Signal-style): both sides
// compute the SAME 60-digit string from the two parties' keys — the pair is
// sorted, so whose device runs it doesn't matter. Rendered as 12 groups of 5
// digits, easy to read over a call. Any change to any of the four keys yields a
// completely different number, which is what makes comparing it meaningful.
export function safetyNumber(
  a: { signPub: string; boxPub: string },
  b: { signPub: string; boxPub: string },
): string {
  const sides = [`${a.signPub}:${a.boxPub}`, `${b.signPub}:${b.boxPub}`].sort();
  const digest = createHash("sha256").update(sides.join("|")).digest();
  const digits: string[] = [];
  for (let i = 0; i < 30; i++) digits.push(String((digest[i] ?? 0) % 100).padStart(2, "0"));
  return (digits.join("").match(/.{5}/g) as string[]).join(" ");
}
