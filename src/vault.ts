// The synced account "vault" (AUTH-SYNC.md): assemble the device's account state
// into one blob to push, and materialise a pulled blob back onto disk. "Sync
// everything" means the blob carries the KEYPAIR too, so a fresh device is fully
// restored — it can open sealed mail and sign as the user. That also makes email
// the master key to the identity; the trade is spelled out in AUTH-SYNC.md.
//
// The blob is stored as plain JSON — server-readable by design (AUTH-SYNC.md §4);
// the route gates it behind the bearer session + paid wall.

import { existsSync, readFileSync } from "node:fs";
import { identityFile, contactsFile, settingsFile, userDir } from "./paths.ts";
import { secureDir, writeSecret, writeSecretAtomic } from "./secure-fs.ts";

export interface VaultBlob {
  v: 1;
  identity: Record<string, unknown> & { handle?: string };
  contacts: unknown;
  settings: unknown;
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

// Gather identity + contacts + settings for a device user into a blob string.
export function assembleVault(user: string): string {
  const blob: VaultBlob = {
    v: 1,
    identity: (readJson(identityFile(user)) as VaultBlob["identity"]) ?? {},
    contacts: readJson(contactsFile(user)),
    settings: readJson(settingsFile(user)),
  };
  return JSON.stringify(blob);
}

// Write a pulled blob to disk and return the handle (directory) it materialised,
// so the caller can make it the device default. Used by link_device on a fresh
// machine and by sync when the server is ahead.
export function applyVault(raw: string): string {
  const blob = JSON.parse(raw) as VaultBlob;
  const handle = blob.identity?.handle;
  if (!handle || typeof handle !== "string")
    throw new Error("vault blob has no handle — cannot materialise identity");
  secureDir(userDir(handle));
  writeSecret(identityFile(handle), JSON.stringify(blob.identity, null, 2) + "\n");
  if (blob.contacts != null)
    writeSecretAtomic(contactsFile(handle), JSON.stringify(blob.contacts, null, 2) + "\n");
  if (blob.settings != null)
    writeSecretAtomic(settingsFile(handle), JSON.stringify(blob.settings, null, 2) + "\n");
  return handle;
}

// Merge a server blob into the local one for the stale-push (409) case: union the
// contact lists (last-write-wins per person by signPub, union their tags) and
// take the server's identity/settings only to fill gaps. Returns the merged blob
// string to re-push. Deliberately simple — contacts are an address book, not a
// chat log, so field-level last-write-wins is good enough (AUTH-SYNC.md §10).
export function mergeVaults(localRaw: string, serverRaw: string): string {
  const local = JSON.parse(localRaw) as VaultBlob;
  const server = JSON.parse(serverRaw) as VaultBlob;
  const lc = (local.contacts as any)?.contacts ?? [];
  const sc = (server.contacts as any)?.contacts ?? [];
  const byKey = new Map<string, any>();
  for (const c of sc) byKey.set(c.signPub ?? c.handle ?? JSON.stringify(c), c);
  for (const c of lc) {
    const k = c.signPub ?? c.handle ?? JSON.stringify(c);
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...prev, ...c, tags: unionTags(prev.tags, c.tags) } : c);
  }
  const mergedContacts = {
    ...(server.contacts as any),
    ...(local.contacts as any),
    contacts: [...byKey.values()],
  };
  return JSON.stringify({ ...server, ...local, contacts: mergedContacts });
}

function unionTags(a?: string[], b?: string[]): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}
