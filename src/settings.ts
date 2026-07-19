// Per-user, LOCAL preferences — never sent to the server. Stored as a small JSON
// file next to the contact book (see paths.ts `settingsFile`). Today it holds one
// thing: the auto-tagging mode. Kept separate from the contact book so reading a
// preference never risks rewriting the book, and from identity.json so it's not
// tangled with the keypair.

import { readFileSync } from "node:fs";
import { writeSecretAtomic } from "./secure-fs.ts";

// How aggressively the agent tags contacts from conversation:
//   auto    — apply obvious tags silently (default; a tag is local + reversible)
//   suggest — propose tags, apply only on the user's confirmation
//   off      — never tag automatically and never ask (manual tag_contact still works)
export type TagMode = "auto" | "suggest" | "off";
export const TAG_MODES: readonly TagMode[] = ["auto", "suggest", "off"] as const;
export const DEFAULT_TAG_MODE: TagMode = "auto";

export interface Settings {
  tagMode: TagMode;
  // FRIENDS.md requests-only mode: a LOCAL mirror of the server-side handle flag,
  // kept so the contacts `me` entry can warn "your handle is off" without a network round-trip. The
  // server is the source of truth; this just reflects the last toggle from here.
  requestsOnly: boolean;
  // The project's feedback contact has been seeded into this account (once,
  // ever). Rides the vault with the rest of settings, so one device seeding
  // covers all — and deleting the contact never resurrects it.
  feedbackSeeded: boolean;
}

function defaults(): Settings {
  return { tagMode: DEFAULT_TAG_MODE, requestsOnly: false, feedbackSeeded: false };
}

// Read settings, falling back to defaults for a missing/corrupt file or any
// unrecognised field — a preferences file should never be able to break a session.
export function loadSettings(path: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
    const tagMode = TAG_MODES.includes(raw?.tagMode as TagMode)
      ? (raw!.tagMode as TagMode)
      : DEFAULT_TAG_MODE;
    return { tagMode, requestsOnly: raw?.requestsOnly === true, feedbackSeeded: raw?.feedbackSeeded === true };
  } catch {
    return defaults();
  }
}

// Persist atomically (temp-write + rename), matching saveContacts — the file may be
// touched from more than one process, so a reader always sees a complete file.
export function saveSettings(path: string, settings: Settings): void {
  writeSecretAtomic(path, JSON.stringify(settings, null, 2) + "\n");
}
