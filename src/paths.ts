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

// A magic-link login that authenticated but still needs the user's display name
// (brand-new email, no identity on this device). The minted session token parks
// HERE between the `need_name` answer and the follow-up `login` call.
//
// Device-level, not per-user, deliberately: at this point in setup there is no
// identity and therefore no user dir to put it in. It holds a bearer token (and
// possibly a stub's private keys), so it is written 0600 like any other secret
// and deleted the moment the login completes.
export function pendingLoginFile(): string {
  return join(dataHome(), "pending-login.json");
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

// Per-user local preferences (e.g. the auto-tagging mode). Never sent to the
// server; see settings.ts.
export function settingsFile(user: string): string {
  return join(userDir(user), "settings.json");
}

// The warmer mirrors current unread mail (decrypted) here so the chat waker can
// watch it WITHOUT opening inbox.db — the cross-process collision that used to
// drop mail on the wasm driver. Warmer is the only writer; consumers only read.
export function pendingFile(user: string): string {
  return join(userDir(user), "pending.json");
}

// Consumers (read_messages) record which pending ids they surfaced here; the
// warmer reads it and marks those read in inbox.db.
export function pendingAckFile(user: string): string {
  return join(userDir(user), "pending-ack.json");
}

// The messenger's own memory (HISTORY.md / AUTO-CHAT.md): a per-user directory of
// plain md files, GLOBAL on purpose (never the working directory — mail must not
// get committed to a repo because a context dir sat in the cwd). Holds the living
// thread files (threads/) and the agent's learned notes (notes/). Same at-rest
// posture as the inbox cache: plaintext, 0600 files / 0700 dirs, local-only —
// never synced to the vault (it's server-readable by design).
export function contextDir(user: string): string {
  return join(userDir(user), "context");
}

// One living page per contact: agent-curated digest on top, mechanical tail of
// recent messages below. See threads.ts.
export function threadsDir(user: string): string {
  return join(contextDir(user), "threads");
}

// Topical fact files the agent curates ("remember X", facts learned from mail,
// answered escalations, pending questions). See threads.ts (notes helpers).
export function notesDir(user: string): string {
  return join(contextDir(user), "notes");
}

// Account layer (AUTH-SYNC.md). The bearer session token for the online account
// (magic-link login). Saved alongside the keys; sent as `Authorization: Bearer`
// on the vault routes. Never leaves the device except as that header.
export function sessionFile(user: string): string {
  return join(userDir(user), "session.json");
}

// Marker that local state (contacts/tags/settings/identity) changed since the
// last vault push, so the next sync knows to upload. A flag file (not a diff)
// keeps mutation sites cheap: they touch it, sync clears it.
export function vaultDirtyFile(user: string): string {
  return join(userDir(user), "vault-dirty");
}

// Outbox for the history sync (AUTH-SYNC.md): messages seen on this device
// (sent AND received) queue here as JSONL until the next encrypted push to the
// account's history stream. Appended by the message paths, drained by
// history-sync.ts; absent/empty = nothing to push.
export function historyOutboxFile(user: string): string {
  return join(userDir(user), "history-outbox.jsonl");
}

// New-handle gate (0.18) side file: a plain JSON array of message ids, always
// OVERWRITTEN with the current gated set (never grows). Holds the ids the live
// feed has already been told about (as a name+handle summary) — written by
// read_messages (chatBatch); read by the waker so it doesn't re-fire on a
// summary the feed already carries.
export function gatedNotifiedFile(user: string): string {
  return join(userDir(user), "gated-notified.json");
}

// While the live inbox ("chat") listener is running it heartbeats this lock file
// (bumping its mtime every tick). A FRESH lock means chat is live: the inbox
// rider stays silent (the feed is the sole surfacing path) and a public
// session's gate bypass applies. See await-mail.ts (writer) and core-net
// readChatLock (reader).
export function chatLockFile(user: string): string {
  return join(userDir(user), "chat.lock");
}
