// Phase 0 contact book: a flat local JSON file per user + an exact-name
// resolver. No social graph, no learned tags yet (Phase 2/3). Resolution is
// case-insensitive match against the contact's name and any aliases.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

// Display names (the user's own, a nickname, a contact's self-name) are capped at
// this many characters. Generous for any real name, but a hard limit so nobody can
// stuff extra data into a name — which matters because a sender's self-name rides
// in EVERY message envelope through the server (payload you pay for per message).
export const NAME_MAX = 128;

// Tags are short, local-only labels ("work", "family") the user/agent attaches to
// a contact. Capped well under a name — they're keywords, not prose.
export const TAG_MAX = 64;

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
  auto?: boolean; // saved automatically from a received self-introduction, NOT a
  // user-chosen nick. While true, `name` is just what they call themselves, so we
  // show "name (handle)"; renaming them (a real nick) clears this and shows the nick.
  sentCount?: number; // how many messages YOU'VE sent them; ranks the "most active"
  // shortcut in the contacts list. Absent on contacts never written to (treated 0).
  lastMessageAt?: number; // epoch ms of the last message you sent them (recency tiebreak).
  tags?: string[]; // LOCAL labels you/the agent attach ("work", "family"). Never sent
  // to the server or another client — purely your own view, used for "write everyone
  // from work". Lower-cased + deduped via cleanTag. Absent when untagged.
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
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(book, null, 2) + "\n");
  renameSync(tmp, path);
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
