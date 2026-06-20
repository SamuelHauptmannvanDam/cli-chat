// Loads a user's private identity (both keypairs) from disk. Secrets stay
// local and are never sent anywhere; only PublicKeys travel (into contacts).

import { readFileSync } from "node:fs";
import type { Identity } from "./crypto.ts";

export function loadIdentity(path: string): Identity {
  const id = JSON.parse(readFileSync(path, "utf8")) as Identity;
  for (const k of ["boxPub", "boxSec", "signPub", "signSec"] as const) {
    if (!id[k]) throw new Error(`identity at ${path} missing ${k}`);
  }
  return id;
}

// The encrypted blob as it travels to / rests in the hosted mailbox.
export interface WireMessage {
  id: string;
  recipient: string; // recipient signPub (mailbox key)
  sender: string; // sender signPub
  body: string; // base64 sealed-box ciphertext
  tags: string | null; // reserved for Phase 2 (encrypted meta tags)
  created_at: number;
  in_reply_to: string | null;
}
