// The synced account "vault" (AUTH-SYNC.md): assemble the device's account state
// into one blob to push, and materialise a pulled blob back onto disk. "Sync
// everything" means the blob carries the KEYPAIR too, so a fresh device is fully
// restored — it can open sealed mail and sign as the user. That also makes email
// the master key to the identity; the trade is spelled out in AUTH-SYNC.md.
//
// v2 blobs also carry the messenger's context FILES (the thread digests under
// context/threads/ and the memory notes under context/notes/), so recall and
// auto-chat grounding follow the account across devices. Message history itself
// is NOT in the vault — it's an append-only chunk stream (history-sync.ts).
//
// The blob is ENCRYPTED CLIENT-SIDE (blob-crypto.ts) before it leaves the device;
// this module deals only in plaintext blobs — callers seal/unseal at the sync
// boundary. Legacy plaintext blobs on the server still apply unchanged.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  identityFile,
  contactsFile,
  settingsFile,
  userDir,
  threadsDir,
  notesDir,
} from "./paths.ts";
import { secureDir, writeSecret, writeSecretAtomic } from "./secure-fs.ts";

export interface VaultBlob {
  v: 1;
  identity: Record<string, unknown> & { handle?: string };
  contacts: unknown;
  settings: unknown;
  // v2 addition (absent on old blobs): context md files, path → content, with
  // paths relative to the user dir ("context/threads/niels.md").
  files?: Record<string, string>;
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

// Flat *.md files of one context dir as { "context/<sub>/<name>": content }.
function readMdFiles(dir: string, rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      try {
        out[`${rel}/${name}`] = readFileSync(join(dir, name), "utf8");
      } catch {
        /* unreadable file — skip, never fail the assemble */
      }
    }
  } catch {
    /* dir race — skip */
  }
  return out;
}

// Gather identity + contacts + settings + context files for a device user into a
// blob string (plaintext — the caller encrypts before pushing).
export function assembleVault(user: string): string {
  const blob: VaultBlob = {
    v: 1,
    identity: (readJson(identityFile(user)) as VaultBlob["identity"]) ?? {},
    contacts: readJson(contactsFile(user)),
    settings: readJson(settingsFile(user)),
    files: {
      ...readMdFiles(threadsDir(user), "context/threads"),
      ...readMdFiles(notesDir(user), "context/notes"),
    },
  };
  return JSON.stringify(blob);
}

// Write a pulled blob to disk and return the handle (directory) it materialised,
// so the caller can make it the device default. Used by login-restore on a fresh
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
  // Context files: only paths inside the two known context subdirs are honoured —
  // the blob names files, never arbitrary disk locations.
  for (const [rel, content] of Object.entries(blob.files ?? {})) {
    const name = rel.split("/").pop() ?? "";
    if (!name.endsWith(".md")) continue;
    let base: string;
    if (rel.startsWith("context/threads/")) base = threadsDir(handle);
    else if (rel.startsWith("context/notes/")) base = notesDir(handle);
    else continue;
    try {
      secureDir(base);
      writeSecretAtomic(join(base, name), content);
    } catch {
      /* one bad file must not sink the restore */
    }
  }
  return handle;
}

// Merge a server blob into the local one for the stale-push (409) case: union the
// contact lists (last-write-wins per person by signPub, union their tags), union
// the context files (local wins per path), and take the server's identity/settings
// only to fill gaps. Returns the merged blob string to re-push. Deliberately
// simple — contacts are an address book, not a chat log, so field-level
// last-write-wins is good enough (AUTH-SYNC.md §10).
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
  const mergedFiles = { ...(server.files ?? {}), ...(local.files ?? {}) };
  return JSON.stringify({ ...server, ...local, contacts: mergedContacts, files: mergedFiles });
}

function unionTags(a?: string[], b?: string[]): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}
