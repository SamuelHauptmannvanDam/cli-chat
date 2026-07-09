// Headless send (AUTO-CHAT.md enabler): `npx cli-chat send <to> <message…>`.
// Lets scripts, CI jobs and other bots participate as plain senders without an
// MCP session — a bot is just another account with a keypair. Uses the same
// sealed path as send_message (so outbound history + thread files apply).
//
//   cli-chat send Niels "deploy landed, your move"
//   cli-chat send Sam --key AbC123 "hello from CI"
//   cli-chat send me "note to self: rotate the token"
//
// Exit 0 on success (prints the message id), 1 on any failure (prints the
// reason). No interactivity — a missing account is an error, never a prompt.

import { initCrypto } from "./crypto.ts";
import { loadIdentity } from "./identity.ts";
import { loadContacts } from "./contacts.ts";
import { openMailbox } from "./db.ts";
import { createMailboxClient } from "./mailbox-client.ts";
import { currentUser } from "./current-user.ts";
import { identityFile, contactsFile, inboxFile, threadsDir } from "./paths.ts";
import { resolveMailboxUrl } from "./config.ts";
import { sendMessage, type NetContext } from "./core-net.ts";

export async function runCliSend(argv: string[]): Promise<number> {
  // Parse: [--key CODE] [--as-assistant] <to> <body words…>
  let key: string | undefined;
  let asAssistant = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--key") key = argv[++i];
    else if (a === "--as-assistant") asAssistant = true;
    else rest.push(a);
  }
  const [to, ...words] = rest;
  const body = words.join(" ").trim();
  if (!to || !body) {
    console.error(`usage: cli-chat send <to> [--key CODE] <message…>`);
    return 1;
  }

  const user = currentUser();
  if (!user) {
    console.error("no account on this device (run the MCP server and create_account first)");
    return 1;
  }
  await initCrypto();
  let me;
  try {
    me = loadIdentity(identityFile(user));
  } catch (e) {
    console.error(`couldn't load identity for "${user}": ${(e as Error).message}`);
    return 1;
  }
  const now = () => Date.now();
  const ctx: NetContext = {
    me,
    book: loadContacts(contactsFile(user)),
    cache: openMailbox(inboxFile(user)),
    client: createMailboxClient(resolveMailboxUrl(), me, now),
    now,
    contactsPath: contactsFile(user),
    threadsPath: threadsDir(user),
  };
  const r = await sendMessage(ctx, { to, body, key, as_assistant: asAssistant });
  if (r.ok) {
    console.log(`sent ${r.id} to ${r.to.name}`);
    return 0;
  }
  const extra = "candidates" in r && r.candidates?.length ? ` (${r.candidates.join(", ")})` : "";
  console.error(`send failed: ${r.reason}${extra}`);
  return 1;
}
