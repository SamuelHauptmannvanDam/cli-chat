// One-time per machine: create your identity (keypair) if you don't have one,
// claim a short 6-character handle in the mailbox registry, and print it. Your
// PRIVATE keys never leave this machine — the registry only stores public keys.
//
//   export MESSENGER_USER=sam
//   node src/init-identity.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { initCrypto, generateIdentity, type Identity } from "./crypto.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { randomHandle } from "./key-code.ts";
import { setCurrentUser } from "./current-user.ts";

const ROOT = resolve(import.meta.dirname, "..");
// Name comes from MESSENGER_USER if given, else the first CLI arg, else the OS
// login name — so `npm run init` Just Works with no env var.
const user = (process.env.MESSENGER_USER || process.argv[2] || userInfo().username).trim();
if (!user) {
  console.error("Couldn't determine a name. Pass one: node src/init-identity.ts <name>");
  process.exit(1);
}
// Make this identity the device default so future sessions need no env var.
mkdirSync(join(ROOT, "users"), { recursive: true });
setCurrentUser(ROOT, user);
const url =
  process.env.MESSENGER_MAILBOX_URL ??
  "https://cli-chat.samuelhauptmannvandam.workers.dev";

await initCrypto();
const dir = join(ROOT, "users", user);
mkdirSync(dir, { recursive: true });
const idPath = join(dir, "identity.json");

let id: Identity;
if (existsSync(idPath)) {
  id = JSON.parse(readFileSync(idPath, "utf8")) as Identity;
  console.error(`Using your existing identity for "${user}".`);
} else {
  id = generateIdentity();
  console.error(`Generated a new identity for "${user}" (private keys stay here).`);
}
// Display name lives in the identity (local only); backfill for older files too.
if (!id.name) {
  id.name = user;
  writeFileSync(idPath, JSON.stringify(id, null, 2) + "\n");
}

const contactsPath = join(dir, "contacts.json");
if (!existsSync(contactsPath)) {
  writeFileSync(contactsPath, JSON.stringify({ me: id.signPub, contacts: [] }, null, 2) + "\n");
}

// Claim a handle in the registry (idempotent for one you already own).
const client = createMailboxClient(url, id, () => Date.now());
try {
  if (!id.handle) {
    let claimed: string | null = null;
    for (let i = 0; i < 8 && !claimed; i++) {
      const candidate = randomHandle(randomBytes(8));
      if ((await client.registerHandle(candidate)) === "ok") claimed = candidate;
    }
    if (!claimed) throw new Error("couldn't find a free handle after several tries");
    id.handle = claimed;
    writeFileSync(idPath, JSON.stringify(id, null, 2) + "\n");
  } else {
    await client.registerHandle(id.handle); // re-assert ownership
  }
  console.error("\n──────────────────────────────────────────────");
  console.error("Your code — give it to anyone who wants to message you. They say:");
  console.error(`  write ${user[0].toUpperCase() + user.slice(1)} at <this code>: hi\n`);
  console.log(id.handle);
  console.error("──────────────────────────────────────────────");
} catch (e) {
  console.error(`\nCouldn't reach the registry (${(e as Error).message}).`);
  console.error("Your identity is saved; re-run this once you're online to claim a handle.");
  process.exit(1);
}
