// Run by the SessionStart hook every time the CLI opens. Signs into the hosted
// mailbox as $MESSENGER_USER, pulls + decrypts anything waiting, prints the
// full message bodies, and marks them read. stdout is injected into the agent's
// context, so it both shows you the mail and lets the agent act on it.
//
// Fails silent (exit 0, no output) on any error or when MESSENGER_USER is unset,
// so it never blocks or noisily breaks a session.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initCrypto } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts, displayNameByKey } from "./contacts.ts";
import { openMailbox, unreadFor, markRead } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { sync, type NetContext } from "./core-net.ts";
import { currentUser } from "./current-user.ts";

const ROOT = resolve(import.meta.dirname, "..");
const user = currentUser(ROOT);
if (!user) process.exit(0); // no identity on this device — stay quiet

// This script is wired to BOTH the SessionStart and UserPromptSubmit hooks.
// The CLI rejects output whose hookSpecificOutput.hookEventName doesn't match
// the event that actually fired, so read the real event name off stdin and
// echo it back. Default to SessionStart if stdin isn't valid hook JSON.
let hookEventName = "SessionStart";
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload?.hook_event_name) hookEventName = payload.hook_event_name;
} catch {
  // no/invalid stdin — keep the default
}

const url =
  process.env.MESSENGER_MAILBOX_URL ??
  "https://cli-chat.samuelhauptmannvandam.workers.dev";

try {
  await initCrypto();
  const me = loadIdentity(join(ROOT, "users", user, "identity.json"));
  const book = loadContacts(join(ROOT, "users", user, "contacts.json"));
  const cache = openMailbox(join(ROOT, "users", user, "inbox.db"));
  const now = () => Date.now();
  const ctx: NetContext = {
    me,
    book,
    cache,
    client: createMailboxClient(url, me, now),
    now,
  };

  await sync(ctx);
  const unread = unreadFor(cache, me.signPub);
  if (unread.length === 0) process.exit(0);

  const out: string[] = [`[inbox] ${unread.length} new message${unread.length > 1 ? "s" : ""}:`];
  for (const m of unread) {
    out.push(`\nFrom ${displayNameByKey(book, m.sender)} (id ${m.id}):`);
    out.push(`  ${m.body}`);
    markRead(cache, m.id, now());
  }
  const text = out.join("\n");

  // Emit JSON so the user SEES the mail on open (systemMessage) AND the agent
  // can act on it (additionalContext). These messages are now marked read, so
  // the agent must use this injected content rather than re-polling
  // messages_available (which would return 0).
  console.log(
    JSON.stringify({
      systemMessage: text,
      hookSpecificOutput: {
        hookEventName,
        additionalContext:
          text +
          `\n\n(These were auto-read on open and shown to the user IN FULL above, ` +
          `already marked read. Do NOT call messages_available/read_message for ` +
          `them and do NOT ask "want me to read it?" — just offer to reply. To ` +
          `reply, use draft_reply with the id above, asking the user for any ` +
          `missing fact first.)`,
      },
    }),
  );
} catch {
  process.exit(0);
}
