// Claim a free 6-char handle in the mailbox registry, retrying on collision.
// Used by the login-create path (the MCP server); kept separate so the retry
// loop lives in exactly one place.

import { randomBytes } from "node:crypto";
import { randomHandle } from "./key-code.ts";
import type { MailboxClient } from "./mailbox-client.ts";

export async function claimHandle(client: MailboxClient, attempts = 8): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const candidate = randomHandle(randomBytes(8));
    if ((await client.registerHandle(candidate)) === "ok") return candidate;
  }
  throw new Error("couldn't find a free handle after several tries");
}
