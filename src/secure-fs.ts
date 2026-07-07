// Filesystem helpers that keep private material — the keypair, the online-account
// session bearer token, and decrypted message bodies mirrored for the hook —
// unreadable by other local user accounts. Everything under
// ~/.cli-chat/users/<handle>/ is secret, so the per-user dir is 0700 and the
// sensitive files are 0600.
//
// The subtlety these wrap: `writeFileSync`'s `mode` option is applied ONLY when
// the file is created — rewriting an existing 0644 file leaves its mode untouched.
// So `writeSecret` chmods after writing to enforce 0600 on files that already
// exist (e.g. identity.json rewritten to update a display name). The atomic
// variant writes a fresh temp each call, so its mode-on-create is always honoured
// and no chmod is needed.
//
// Every chmod is best-effort: Windows has no POSIX modes, so a throw there is
// meaningless and must never break a write — hence the swallowed catches.

import { writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function enforce(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* non-POSIX fs (Windows) or missing file — nothing to enforce */
  }
}

// Write a secret file owner-only. The chmod is what protects a pre-existing 0644
// file, since writeFileSync's mode is ignored once the file exists.
export function writeSecret(path: string, data: string): void {
  writeFileSync(path, data, { mode: FILE_MODE });
  enforce(path, FILE_MODE);
}

// Atomic secret write: a fresh temp (mode honoured on create) renamed over the
// target, which inherits the temp's mode. Mirrors the saveContacts temp+rename so
// concurrent writers (warmer + hook) never expose a torn OR world-readable file.
export function writeSecretAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: FILE_MODE });
  renameSync(tmp, path);
}

// Create a directory (recursively) owner-only. Applies to every level created.
export function secureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  enforce(path, DIR_MODE);
}

// Retroactively tighten an existing install at session start: dir → 0700, the
// listed files → 0600. `writeSecret`'s mode only bites on new files, so without
// this an account created before these helpers existed keeps its old 0644 keys.
// Best-effort throughout: a missing file or a non-POSIX fs is silently fine.
export function hardenExisting(dir: string, files: string[]): void {
  enforce(dir, DIR_MODE);
  for (const f of files) enforce(f, FILE_MODE);
}
