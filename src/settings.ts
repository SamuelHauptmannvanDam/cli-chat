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
}

function defaults(): Settings {
  return { tagMode: DEFAULT_TAG_MODE };
}

// Read settings, falling back to defaults for a missing/corrupt file or any
// unrecognised field — a preferences file should never be able to break a session.
export function loadSettings(path: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
    const tagMode = TAG_MODES.includes(raw?.tagMode as TagMode)
      ? (raw!.tagMode as TagMode)
      : DEFAULT_TAG_MODE;
    return { tagMode };
  } catch {
    return defaults();
  }
}

// Persist atomically (temp-write + rename), matching saveContacts — the file may be
// touched from more than one process, so a reader always sees a complete file.
export function saveSettings(path: string, settings: Settings): void {
  writeSecretAtomic(path, JSON.stringify(settings, null, 2) + "\n");
}
