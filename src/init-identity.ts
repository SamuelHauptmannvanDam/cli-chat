// One-time per machine: create your identity (keypair), claim a short 6-char
// handle in the mailbox registry, and print it. The identity is stored on disk
// keyed by that handle (users/<handle>/); the name you pass is just a cosmetic
// display label saved inside identity.json. PRIVATE keys never leave this
// machine — the registry only stores public keys.
//
//   node src/init-identity.ts [display-name]
//
// If this device already has an identity it reuses it (re-asserting its handle)
// rather than minting a second one.

import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { initCrypto, generateIdentity, type Identity } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { randomHandle } from "./key-code.ts";
import { currentUser, setCurrentUser } from "./current-user.ts";

const ROOT = resolve(import.meta.dirname, "..");
// Display name: MESSENGER_USER, else the first CLI arg, else the OS login name.
const display = (process.env.MESSENGER_USER || process.argv[2] || userInfo().username).trim();
if (!display) {
  console.error("Couldn't determine a name. Pass one: node src/init-identity.ts <name>");
  process.exit(1);
}
const url =
  process.env.MESSENGER_MAILBOX_URL ??
  "https://cli-chat.samuelhauptmannvandam.workers.dev";

await initCrypto();
mkdirSync(join(ROOT, "users"), { recursive: true });

// Reuse an existing identity on this device if there is one.
const existingDir = currentUser(ROOT);
let id: Identity;
let existing = false;
if (existingDir) {
  try {
    id = loadIdentity(join(ROOT, "users", existingDir, "identity.json"));
    existing = true;
    console.error(`Using your existing identity (${id.name ?? existingDir}).`);
  } catch {
    id = generateIdentity();
    id.name = display;
  }
} else {
  id = generateIdentity();
  id.name = display;
}

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
  } else {
    await client.registerHandle(id.handle); // re-assert ownership
  }

  // Persist under the handle-keyed directory.
  const dir = join(ROOT, "users", id.handle);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), JSON.stringify(id, null, 2) + "\n");
  const contactsPath = join(dir, "contacts.json");
  if (!existing) {
    writeFileSync(contactsPath, JSON.stringify({ me: id.signPub, contacts: [] }, null, 2) + "\n");
  }
  setCurrentUser(ROOT, id.handle);

  console.error("\n──────────────────────────────────────────────");
  console.error(`Your code — give it to anyone who wants to message you. They say:`);
  console.error(`  write ${display} at <this code>: hi\n`);
  console.log(id.handle);
  console.error("──────────────────────────────────────────────");
} catch (e) {
  console.error(`\nCouldn't reach the registry (${(e as Error).message}).`);
  console.error("No handle claimed — re-run this once you're online. (A handle is");
  console.error("required: it's the key your identity is stored under.)");
  process.exit(1);
}
