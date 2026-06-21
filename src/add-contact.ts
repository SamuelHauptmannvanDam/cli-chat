// Add (or update) a contact from the public keys a coworker sent you. Run the
// exact line they got from `init-identity`. Requires your own identity to exist
// (run init-identity first).
//
//   export MESSENGER_USER=sam
//   node src/add-contact.ts Alice <signPub> <boxPub>

import { existsSync, readFileSync } from "node:fs";
import { initCrypto } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { saveContacts, type ContactBook } from "./contacts.ts";
import { currentUser } from "./current-user.ts";
import { identityFile, contactsFile } from "./paths.ts";

const user = currentUser();
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
const idPath = identityFile(user);
if (!existsSync(idPath)) {
  console.error(`No identity yet for "${user}". Run:  node src/init-identity.ts`);
  process.exit(1);
}
const me = loadIdentity(idPath);

const contactsPath = contactsFile(user);
const book: ContactBook = existsSync(contactsPath)
  ? (JSON.parse(readFileSync(contactsPath, "utf8")) as ContactBook)
  : { me: me.signPub, contacts: [] };
book.me = me.signPub;

const id = name.toLowerCase();
// Replace any existing entry with the same local name or same key.
book.contacts = book.contacts.filter((c) => c.id !== id && c.signPub !== signPub);
book.contacts.push({ id, name, signPub, boxPub });
saveContacts(contactsPath, book);

console.log(`Added "${name}". You can now message them:  write ${name}: <your message>`);
