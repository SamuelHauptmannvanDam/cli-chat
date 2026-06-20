// Resolves WHERE per-user state (identity, contacts, the inbox cache) lives on
// disk. This is deliberately DECOUPLED from where the code lives: when the
// package is run via `npx`, the code sits in an ephemeral npm cache that gets
// garbage-collected, so writing state next to it would silently lose accounts.
// State therefore lives in a stable home directory instead.
//
// Resolution order (the returned value is the PARENT of the `users/` dir):
//   1. $MESSENGER_HOME   — explicit override (tests, custom setups)
//   2. <repo>/users      — a cloned/dev checkout that already has an in-repo
//                          users/ dir keeps using it, so existing installs need
//                          no data move
//   3. ~/.cli-chat       — the default for fresh installs (e.g. via npx)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where the code lives (…/src in dev, …/dist once bundled). Used ONLY to detect
// a legacy in-repo users/ dir — never to store state.
const codeRoot = resolve(import.meta.dirname, "..");

// Base data dir: the PARENT of the per-user `users/` directory. Read fresh each
// call so tests can point MESSENGER_HOME at a temp dir per case.
export function dataHome(): string {
  const env = process.env.MESSENGER_HOME?.trim();
  if (env) return env;
  if (existsSync(join(codeRoot, "users"))) return codeRoot; // legacy/dev checkout
  return join(homedir(), ".cli-chat");
}

export function usersDir(): string {
  return join(dataHome(), "users");
}

export function userDir(user: string): string {
  return join(usersDir(), user);
}

export function identityFile(user: string): string {
  return join(userDir(user), "identity.json");
}

export function contactsFile(user: string): string {
  return join(userDir(user), "contacts.json");
}

export function inboxFile(user: string): string {
  return join(userDir(user), "inbox.db");
}
