// Phase 0 contact book: a flat local JSON file per user + an exact-name
// resolver. No social graph, no learned tags yet (Phase 2/3). Resolution is
// case-insensitive match against the contact's name and any aliases.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

export interface Contact {
  id: string; // the recipient user id used by the mailbox (Phase 0)
  name: string; // YOUR nickname for them — what you see in the terminal, e.g. "Niels"
  aliases?: string[]; // alternative spellings the resolver also matches
  signPub?: string; // Phase 1: contact's Ed25519 address (mailbox key)
  boxPub?: string; // Phase 1: contact's X25519 key we seal messages to
  handle?: string; // their shareable 6-char code, when known (carried in their messages)
  auto?: boolean; // saved automatically from a received self-introduction, NOT a
  // user-chosen nick. While true, `name` is just what they call themselves, so we
  // show "name (handle)"; renaming them (a real nick) clears this and shows the nick.
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
  if (exact.length === 1) return { status: "resolved", contact: exact[0] };
  if (exact.length > 1) return { status: "ambiguous", query, candidates: exact };

  // No exact hit — try a looser substring match (skip empty queries, which
  // would "contain" into every contact).
  if (!q) return { status: "none", query };
  const fuzzy = book.contacts.filter((c) => namesOf(c).some((n) => n.includes(q)));
  if (fuzzy.length === 1) return { status: "resolved", contact: fuzzy[0] };
  if (fuzzy.length > 1) return { status: "ambiguous", query, candidates: fuzzy };
  return { status: "none", query };
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
