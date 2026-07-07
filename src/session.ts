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

export function saveSession(user: string, token: string, email: string, now: number): void {
  const prev = loadSession(user);
  write(user, { token, email, savedAt: now, vaultVersion: prev?.vaultVersion });
}

// Record the server vault version this device is now in step with.
export function setVaultVersion(user: string, version: number): void {
  const s = loadSession(user);
  if (s) write(user, { ...s, vaultVersion: version });
}

export function clearSession(user: string): void {
  rmSync(sessionFile(user), { force: true });
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
