// Migrate identities from the old name-keyed layout (users/<name>/) to the new
// handle-keyed layout (users/<handle>/). For each identity:
//   - if it has no handle yet, claim one (the handle is now the storage key);
//   - backfill the display `name` from the old folder name if missing;
//   - rename the directory to its handle;
//   - repoint users/.current at the handle if it referred to this identity.
// Safe to re-run: identities already keyed by their handle are left untouched.
//
//   node src/migrate.ts

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { initCrypto, type Identity } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { randomHandle } from "./key-code.ts";
import { usersDir as usersDirFn } from "./paths.ts";

const usersDir = usersDirFn();
const url =
  process.env.MESSENGER_MAILBOX_URL ??
  "https://cli-chat.samuelhauptmannvandam.workers.dev";

await initCrypto();

if (!existsSync(usersDir)) {
  console.log("No users/ directory — nothing to migrate.");
  process.exit(0);
}

const pointerPath = join(usersDir, ".current");
const currentBefore = existsSync(pointerPath) ? readFileSync(pointerPath, "utf8").trim() : null;

const dirs = readdirSync(usersDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => existsSync(join(usersDir, name, "identity.json")));

// old dir name -> new handle, for fixing .current afterwards
const remap = new Map<string, string>();

for (const dir of dirs) {
  const idPath = join(usersDir, dir, "identity.json");
  let id: Identity;
  try {
    id = loadIdentity(idPath);
  } catch (e) {
    console.error(`! ${dir}: can't load identity (${(e as Error).message}) — skipping.`);
    continue;
  }

  let dirty = false;
  if (!id.name) {
    id.name = dir; // preserve the old folder name as the display label
    dirty = true;
  }
  if (!id.handle) {
    const client = createMailboxClient(url, id, () => Date.now());
    let claimed: string | null = null;
    for (let i = 0; i < 8 && !claimed; i++) {
      const candidate = randomHandle(randomBytes(8));
      if ((await client.registerHandle(candidate)) === "ok") claimed = candidate;
    }
    if (!claimed) {
      console.error(`! ${dir}: couldn't claim a handle — leaving as-is.`);
      continue;
    }
    id.handle = claimed;
    dirty = true;
    console.log(`+ ${dir}: claimed handle ${id.handle}`);
  }

  if (dirty) writeFileSync(idPath, JSON.stringify(id, null, 2) + "\n");
  remap.set(dir, id.handle);

  if (dir === id.handle) {
    console.log(`= ${dir}: already keyed by handle.`);
    continue;
  }
  const target = join(usersDir, id.handle);
  if (existsSync(target)) {
    console.error(`! ${dir} -> ${id.handle}: target already exists — skipping rename.`);
    continue;
  }
  renameSync(join(usersDir, dir), target);
  console.log(`→ ${dir} -> ${id.handle} (name "${id.name}")`);
}

// Repoint .current if it referred to a renamed identity (by old dir name, by
// display name, or it was already a handle).
if (currentBefore) {
  let newCurrent: string | null = null;
  if (remap.has(currentBefore)) {
    newCurrent = remap.get(currentBefore)!;
  } else {
    const low = currentBefore.toLowerCase();
    for (const handle of remap.values()) {
      const id = loadIdentity(join(usersDir, handle, "identity.json"));
      if (id.handle === currentBefore || (id.name && id.name.toLowerCase() === low)) {
        newCurrent = handle;
        break;
      }
    }
  }
  if (newCurrent && newCurrent !== currentBefore) {
    writeFileSync(pointerPath, newCurrent + "\n");
    console.log(`. .current: "${currentBefore}" -> "${newCurrent}"`);
  }
}

console.log("Migration complete.");
