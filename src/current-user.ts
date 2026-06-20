// Resolves which identity this device acts as — WITHOUT requiring MESSENGER_USER
// to be exported in every shell. This is what lets the MCP server (and the
// SessionStart hook) start cleanly under Claude Code, which launches them with
// no inherited env. Priority:
//   1. MESSENGER_USER env var   — explicit override (e.g. multi-identity tests)
//   2. users/.current           — the device default, written by `npm run init`
//   3. the only users/<name> dir — zero-config when exactly one identity exists
// Returns null if none resolve, so callers can decide whether to hint or stay
// quiet.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pointerPath = (root: string) => join(root, "users", ".current");

export function currentUser(root: string): string | null {
  const env = process.env.MESSENGER_USER?.trim();
  if (env) return env;

  const pointer = pointerPath(root);
  if (existsSync(pointer)) {
    const name = readFileSync(pointer, "utf8").trim();
    if (name) return name;
  }

  const usersDir = join(root, "users");
  if (existsSync(usersDir)) {
    const dirs = readdirSync(usersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (dirs.length === 1) return dirs[0];
  }
  return null;
}

// Make `user` the device default, so future sessions resolve it with no env var.
export function setCurrentUser(root: string, user: string): void {
  writeFileSync(pointerPath(root), user + "\n");
}
