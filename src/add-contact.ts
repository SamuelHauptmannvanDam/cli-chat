// Add (or update) a contact from the public keys a coworker sent you. Run the
// exact line they got from `init-identity`. Requires your own identity to exist
// (run init-identity first).
//
//   export MESSENGER_USER=sam
//   node src/add-contact.ts Alice <signPub> <boxPub>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initCrypto } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import type { ContactBook } from "./contacts.ts";
import { currentUser } from "./current-user.ts";

const ROOT = resolve(import.meta.dirname, "..");
const user = currentUser(ROOT);
if (!user) {
  console.error("No identity on this device. Run `npm run init`, or set MESSENGER_USER.");
  process.exit(1);
}

const [name, signPub, boxPub] = process.argv.slice(2);
if (!name || !signPub || !boxPub) {
  console.error("Usage: node src/add-contact.ts <Name> <signPub> <boxPub>");
  process.exit(1);
}
const isHex64 = (s: string) => /^[0-9a-f]{64}$/i.test(s);
if (!isHex64(signPub) || !isHex64(boxPub)) {
  console.error("signPub and boxPub must each be 64 hex chars. Check what was pasted.");
  process.exit(1);
}

await initCrypto();
const dir = join(ROOT, "users", user);
const idPath = join(dir, "identity.json");
if (!existsSync(idPath)) {
  console.error(`No identity yet for "${user}". Run:  node src/init-identity.ts`);
  process.exit(1);
}
const me = loadIdentity(idPath);

const contactsPath = join(dir, "contacts.json");
const book: ContactBook = existsSync(contactsPath)
  ? (JSON.parse(readFileSync(contactsPath, "utf8")) as ContactBook)
  : { me: me.signPub, contacts: [] };
book.me = me.signPub;

const id = name.toLowerCase();
// Replace any existing entry with the same local name or same key.
book.contacts = book.contacts.filter((c) => c.id !== id && c.signPub !== signPub);
book.contacts.push({ id, name, signPub, boxPub });
writeFileSync(contactsPath, JSON.stringify(book, null, 2) + "\n");

console.log(`Added "${name}". You can now message them:  write ${name}: <your message>`);
