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

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pointerPath = (root: string) => join(root, "users", ".current");

// Directory names under users/ that actually hold an identity.
function identityDirs(root: string): string[] {
  const usersDir = join(root, "users");
  if (!existsSync(usersDir)) return [];
  return readdirSync(usersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(usersDir, name, "identity.json")));
}

function readMeta(root: string, dir: string): { handle?: string; name?: string; signPub?: string } | null {
  try {
    return JSON.parse(readFileSync(join(root, "users", dir, "identity.json"), "utf8"));
  } catch {
    return null;
  }
}

// Map a selector (handle | display name | signPub | literal dir) to a dir name.
function resolveDir(root: string, sel: string): string | null {
  const dirs = identityDirs(root);
  if (dirs.includes(sel)) return sel; // already a directory name (i.e. a handle)
  const low = sel.toLowerCase();
  for (const d of dirs) {
    const id = readMeta(root, d);
    if (!id) continue;
    if (id.handle === sel || id.signPub === sel) return d;
    if (id.name && id.name.toLowerCase() === low) return d;
  }
  return null;
}

export function currentUser(root: string): string | null {
  const env = process.env.MESSENGER_USER?.trim();
  if (env) return resolveDir(root, env) ?? env; // unresolved → return raw (boots no-account)

  const pointer = pointerPath(root);
  if (existsSync(pointer)) {
    const val = readFileSync(pointer, "utf8").trim();
    if (val) return resolveDir(root, val) ?? val;
  }

  const dirs = identityDirs(root);
  if (dirs.length === 1) return dirs[0];
  return null;
}

// Make `key` the device default. Pass the handle (the stable on-disk key).
export function setCurrentUser(root: string, key: string): void {
  writeFileSync(pointerPath(root), key + "\n");
}
