// Local persistence of the online-account session (AUTH-SYNC.md). The session
// token is a long-lived bearer credential minted by the mailbox after a
// magic-link login; it lives next to the user's keys and authorizes the vault
// sync routes. This module just reads/writes that file — the HTTP is in
// account-client.ts.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { sessionFile, vaultDirtyFile } from "./paths.ts";
import { writeSecret } from "./secure-fs.ts";

export interface SessionState {
  token: string; // bearer session token (the secret)
  email: string; // the account email it belongs to
  savedAt: number;
  // Last server vault version this device has seen. Push sends version+1; pull
  // updates it. Lets last-write-wins converge without re-uploading unchanged data.
  vaultVersion?: number;
  // The account's data key (hex) — encrypts vault/history blobs before they leave
  // the device (blob-crypto.ts). Handed over on login; fetched once for sessions
  // that predate encrypted blobs.
  dataKey?: string;
  // Highest history seq this device has pulled (history-sync.ts). Push appends
  // fresh chunks; pull advances this cursor.
  historyCursor?: number;
}

export function loadSession(user: string): SessionState | null {
  const path = sessionFile(user);
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as SessionState;
    return s.token ? s : null;
  } catch {
    return null;
  }
}

function write(user: string, s: SessionState): void {
  writeSecret(sessionFile(user), JSON.stringify(s, null, 2) + "\n");
}

export function saveSession(
  user: string,
  token: string,
  email: string,
  now: number,
  dataKey?: string,
): void {
  const prev = loadSession(user);
  write(user, {
    token,
    email,
    savedAt: now,
    vaultVersion: prev?.vaultVersion,
    dataKey: dataKey ?? prev?.dataKey,
    historyCursor: prev?.historyCursor,
  });
}

// Record the server vault version this device is now in step with.
export function setVaultVersion(user: string, version: number): void {
  const s = loadSession(user);
  if (s) write(user, { ...s, vaultVersion: version });
}

// Store the account data key on a session that predates it (upgrade path).
export function setDataKey(user: string, dataKey: string): void {
  const s = loadSession(user);
  if (s) write(user, { ...s, dataKey });
}

// Record the highest history seq this device has pulled.
export function setHistoryCursor(user: string, cursor: number): void {
  const s = loadSession(user);
  if (s) write(user, { ...s, historyCursor: cursor });
}

// --- Dirty flag: did local state change since the last successful push? ------
export function markVaultDirty(user: string): void {
  try {
    writeFileSync(vaultDirtyFile(user), "1");
  } catch {
    /* best-effort: a failed mark just means the next session-start sync pushes */
  }
}

export function isVaultDirty(user: string): boolean {
  return existsSync(vaultDirtyFile(user));
}

export function clearVaultDirty(user: string): void {
  rmSync(vaultDirtyFile(user), { force: true });
}
