// Resolves which identity this device acts as. The on-disk identity is keyed by
// its HANDLE (the 6-char contact code) — never by the human name, which is just
// a cosmetic label inside identity.json. A selector (from MESSENGER_USER or the
// `.current` pointer) may be a handle, a display name, a signPub, or a literal
// directory name; we resolve any of those to the directory that holds it.
//
// Priority:
//   1. MESSENGER_USER env var   — explicit override (handle | name | signPub | dir)
//   2. users/.current           — the device default (a handle), written at setup
//   3. the only identity dir     — zero-config when exactly one identity exists
// Returns null if none resolve, so callers can decide whether to hint or stay
// quiet. The returned value is the on-disk DIRECTORY name under users/.
//
// All on-disk locations come from paths.ts (the data home), NOT the code dir, so
// state survives an ephemeral npx install. See src/paths.ts.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usersDir, identityFile } from "./paths.ts";

const pointerPath = () => join(usersDir(), ".current");

// Directory names under users/ that actually hold an identity.
function identityDirs(): string[] {
  const dir = usersDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(identityFile(name)));
}

function readMeta(dir: string): { handle?: string; name?: string; signPub?: string } | null {
  try {
    return JSON.parse(readFileSync(identityFile(dir), "utf8"));
  } catch {
    return null;
  }
}

// Map a selector (handle | display name | signPub | literal dir) to a dir name.
function resolveDir(sel: string): string | null {
  const dirs = identityDirs();
  if (dirs.includes(sel)) return sel; // already a directory name (i.e. a handle)
  const low = sel.toLowerCase();
  for (const d of dirs) {
    const id = readMeta(d);
    if (!id) continue;
    if (id.handle === sel || id.signPub === sel) return d;
    if (id.name && id.name.toLowerCase() === low) return d;
  }
  return null;
}

export function currentUser(): string | null {
  const env = process.env.MESSENGER_USER?.trim();
  if (env) return resolveDir(env) ?? env; // unresolved → return raw (boots no-account)

  const pointer = pointerPath();
  if (existsSync(pointer)) {
    const val = readFileSync(pointer, "utf8").trim();
    if (val) return resolveDir(val) ?? val;
  }

  const dirs = identityDirs();
  if (dirs.length === 1) return dirs[0];
  return null;
}

// Make `key` the device default. Pass the handle (the stable on-disk key).
export function setCurrentUser(key: string): void {
  writeFileSync(pointerPath(), key + "\n");
}
