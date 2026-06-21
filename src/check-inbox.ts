// Run by the SessionStart hook every time the CLI opens. Signs into the hosted
// mailbox as $MESSENGER_USER, pulls + decrypts anything waiting, and marks it
// read. The USER is shown only a count + who from (an offer to read); the full
// bodies go privately to the agent via additionalContext so it can read them
// out on request without re-fetching.
//
// Fails silent (exit 0, no output) on any error or when MESSENGER_USER is unset,
// so it never blocks or noisily breaks a session.

import { readFileSync } from "node:fs";
import { initCrypto } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts, senderLabel } from "./contacts.ts";
import { openMailbox, unreadFor, markRead } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { sync, type NetContext } from "./core-net.ts";
import { currentUser } from "./current-user.ts";
import { identityFile, contactsFile, inboxFile } from "./paths.ts";
import { resolveMailboxUrl } from "./config.ts";

const user = currentUser();

// This script is wired to BOTH the SessionStart and UserPromptSubmit hooks.
// The CLI rejects output whose hookSpecificOutput.hookEventName doesn't match
// the event that actually fired, so read the real event name off stdin and
// echo it back. Default to SessionStart if stdin isn't valid hook JSON.
let hookEventName = "SessionStart";
// Stop hooks pass stop_hook_active=true when the stop is itself the result of a
// previous Stop-hook continuation — our guard against looping on the forced turn.
let stopHookActive = false;
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload?.hook_event_name) hookEventName = payload.hook_event_name;
  if (payload?.stop_hook_active) stopHookActive = true;
} catch {
  // no/invalid stdin — keep the default
}

// On a Stop that's already a continuation of our own block, do nothing — the
// mail we surfaced was marked read, so this only guards the rare race where the
// re-prompted turn hasn't relayed yet. Cheaper than re-syncing the network.
if (hookEventName === "Stop" && stopHookActive) process.exit(0);

// Does this device have an account yet? If not, nudge the user to set up — but
// only ONCE per session (on SessionStart), never nagging on every prompt. We
// can check without crypto: loadIdentity just reads + validates the JSON.
let setUp = false;
if (user) {
  try {
    loadIdentity(identityFile(user));
    setUp = true;
  } catch {
    /* identity dir/file missing — treat as not set up */
  }
}
if (!setUp) {
  if (hookEventName === "SessionStart") {
    const text =
      "You don't have a cli-chat account on this device yet — I'll create one " +
      "automatically the first time you message someone. Say \"set me up as Sam\" " +
      "if you'd like to choose your name (and get your 6-character code) now.";
    console.log(
      JSON.stringify({
        systemMessage: text,
        hookSpecificOutput: {
          hookEventName,
          additionalContext:
            text +
            " (No identity exists on this device. The other messaging tools return " +
            "no_account until then; when that happens, or if the user asks to get " +
            "set up, call create_account automatically — defaulting the name to the " +
            "OS login unless the user gave one — then continue.)",
        },
      }),
    );
  }
  process.exit(0); // nothing more to do without an account
}

const url = resolveMailboxUrl();

try {
  await initCrypto();
  const me = loadIdentity(identityFile(user));
  const book = loadContacts(contactsFile(user));
  const cache = openMailbox(inboxFile(user));
  const now = () => Date.now();
  const ctx: NetContext = {
    me,
    book,
    cache,
    client: createMailboxClient(url, me, now),
    now,
    // Persist any contact auto-saved from an incoming self-introduction during sync.
    contactsPath: contactsFile(user),
  };

  // If this account never got a real display name (older identity, or one
  // backfilled to the handle), the people we message see only a key prefix. Nudge
  // the agent — once, on session open — to ask what to call the user.
  const namePlaceholder = !me.name || me.name === me.handle || me.name === user;

  // Who this device represents — handed to the agent (not the user) as context
  // so it knows whose messenger it is. Display name lives in the identity now.
  let whoami =
    `You are acting as the messenger for ${me.name ?? user}` +
    (me.handle ? ` (their code is ${me.handle})` : "") + ".";

  // The ask to run, once on session open, when the user has no real name set —
  // their name now travels with every message they send, so it's worth having.
  const nudgeAsk = namePlaceholder && hookEventName === "SessionStart";
  const nameAskUser =
    "👤 You haven't set a name yet — it's what people see when you message them. " +
    "What should I call you?";
  if (nudgeAsk) {
    whoami +=
      " The user has NOT set a display name (it's still a placeholder), so the " +
      "people they message see only a key prefix. Their name now travels with " +
      "each message they send. Ask them once, conversationally, what you should " +
      "call them, then call create_account with that name to set it. Don't nag if " +
      "they decline.";
  }

  await sync(ctx);
  const unread = unreadFor(cache, me.signPub);
  if (unread.length === 0) {
    // No mail. On session open, still give the agent its identity (agent-only,
    // no user-facing systemMessage) — plus, if needed, the name ask.
    if (hookEventName === "SessionStart") {
      console.log(
        JSON.stringify({
          ...(nudgeAsk ? { systemMessage: nameAskUser } : {}),
          hookSpecificOutput: { hookEventName, additionalContext: whoami },
        }),
      );
    }
    process.exit(0);
  }

  // What the USER sees: just a count + who from, and an offer to read — NOT the
  // bodies. Senders are de-duplicated and listed so "1 new message from Sam"
  // reads naturally.
  const senders = [...new Set(unread.map((m) => senderLabel(book, m.sender)))];
  const noun = `${unread.length} new message${unread.length > 1 ? "s" : ""}`;
  let summary = `📬 ${noun} from ${senders.join(", ")} — want me to read ${unread.length > 1 ? "them" : "it"}?`;
  // On session open, also nudge the hands-free option: a watch loop that
  // auto-reads incoming mail straight into the chat. Only on SessionStart so it
  // doesn't repeat on every per-turn inbox check mid-session.
  if (hookEventName === "SessionStart") {
    summary += `\n   ↳ Tip: write "watch" in a new terminal for auto-reading new messages into our chat.`;
  }
  if (nudgeAsk) summary += `\n   ↳ ${nameAskUser}`;

  // What the AGENT gets (privately, hidden from the user): the full bodies + ids
  // so it can print them ON REQUEST without re-fetching, plus how to behave. The
  // messages are marked read here so the per-turn hook won't re-announce them.
  const bodies: string[] = [];
  for (const m of unread) {
    bodies.push(`\nFrom ${senderLabel(book, m.sender)} (id ${m.id}):\n  ${m.body}`);
    markRead(cache, m.id, now());
  }

  const agentContext =
    whoami +
    `\n\n[inbox] ${noun} waiting (already marked read). The user has ONLY ` +
    `been shown a count, NOT the contents. Do NOT print the bodies below ` +
    `unless the user asks to hear them (e.g. "read it", "go on", "yes"); ` +
    `then print the relevant message in full. Do NOT call ` +
    `messages_available/read_message for these — use the bodies here. To ` +
    `reply, use draft_reply with the id, asking for any missing fact first. ` +
    `The on-open summary already shows a "say watch" tip, so don't repeat ` +
    `it; if the user says "watch", call the \`watch\` tool and auto-read new ` +
    `mail in full as it arrives.\n` +
    bodies.join("\n");

  if (hookEventName === "Stop") {
    // The turn just ended, so additionalContext would sit unread until the user
    // types again — defeating the point. Instead block the stop: the user sees
    // the count via systemMessage and the agent earns one more turn (reason) to
    // relay it. Mail is already marked read + stopHookActive guards re-entry, so
    // the next Stop finds nothing and lets the turn end normally — no loop.
    console.log(
      JSON.stringify({
        decision: "block",
        reason:
          `Mail arrived while you were working — surface it now. ` + agentContext,
        systemMessage: summary,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        systemMessage: summary,
        hookSpecificOutput: { hookEventName, additionalContext: agentContext },
      }),
    );
  }
} catch {
  process.exit(0);
}
