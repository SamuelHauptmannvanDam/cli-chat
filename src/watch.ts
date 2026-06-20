// Background watcher: polls the mailbox on an interval, pulls + decrypts new
// mail into the local inbox cache, and fires a desktop notification. Runs
// independently of any CLI, so it works the same regardless of which agent CLI
// you use. It does NOT mark messages read — your CLI still surfaces them.
//
//   export MESSENGER_USER=sam
//   node src/watch.ts            # polls every 60s (MESSENGER_POLL_SECONDS to change)
//
// Note: this notifies YOU; it can't make the agent speak unprompted (that's
// real push — Phase 4). When you next touch any CLI, the mail is already cached.

import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { initCrypto } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts, displayNameByKey } from "./contacts.ts";
import { openMailbox, unreadFor } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { sync, type NetContext } from "./core-net.ts";
import { currentUser } from "./current-user.ts";

const ROOT = resolve(import.meta.dirname, "..");
const user = currentUser(ROOT);
if (!user) {
  console.error("No identity on this device. Run `npm run init`, or set MESSENGER_USER.");
  process.exit(1);
}
const url =
  process.env.MESSENGER_MAILBOX_URL ??
  "https://cli-chat.samuelhauptmannvandam.workers.dev";
// Default 10s for easy testing; raise via MESSENGER_POLL_SECONDS (floor 5s).
const intervalMs = Math.max(5, Number(process.env.MESSENGER_POLL_SECONDS ?? 10)) * 1000;

await initCrypto();
const dir = join(ROOT, "users", user);
const me = loadIdentity(join(dir, "identity.json"));
const book = loadContacts(join(dir, "contacts.json"));
const cache = openMailbox(join(dir, "inbox.db"));
const now = () => Date.now();
const ctx: NetContext = {
  me,
  book,
  cache,
  client: createMailboxClient(url, me, now),
  now,
  contactsPath: join(dir, "contacts.json"),
};

function notify(title: string, message: string): void {
  // Desktop notifications are opt-in (MESSENGER_NOTIFY=1). By default the
  // watcher just keeps your local cache warm silently; new mail surfaces
  // in-chat via the SessionStart / UserPromptSubmit hooks instead.
  if (process.env.MESSENGER_NOTIFY !== "1") return;
  process.stdout.write("\x07"); // terminal bell, everywhere
  if (process.platform === "darwin") {
    const safe = (s: string) => s.replace(/["\\]/g, " ");
    execFile("osascript", ["-e", `display notification "${safe(message)}" with title "${safe(title)}"`], () => {});
  } else if (process.platform === "linux") {
    execFile("notify-send", [title, message], () => {});
  }
}

async function pollOnce(): Promise<void> {
  let added = 0;
  try {
    added = await sync(ctx);
  } catch (e) {
    // Network blips are normal; stay quiet and try again next tick.
    return;
  }
  if (added > 0) {
    const unread = unreadFor(cache, me.signPub);
    const latest = unread[unread.length - 1];
    const from = latest ? displayNameByKey(book, latest.sender) : "someone";
    const ts = new Date(now()).toISOString().slice(11, 19);
    console.log(`[${ts}] ${added} new — latest from ${from}: "${latest?.body?.slice(0, 60) ?? ""}"`);
    notify("New message", `${from}: ${latest?.body?.slice(0, 80) ?? ""}`);
  }
}

console.error(`watching mailbox for "${user}" every ${intervalMs / 1000}s (Ctrl+C to stop)`);
await pollOnce();
setInterval(pollOnce, intervalMs);
