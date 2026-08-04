// Loads a user's private identity (both keypairs) from disk. Secrets stay
// local and are never sent anywhere; only the public keys travel (into contacts).

import { readFileSync } from "node:fs";
import type { Identity } from "./core/crypto.ts";

export function loadIdentity(path: string): Identity {
  const id = JSON.parse(readFileSync(path, "utf8")) as Identity;
  for (const k of ["boxPub", "boxSec", "signPub", "signSec"] as const) {
    if (!id[k]) throw new Error(`identity at ${path} missing ${k}`);
  }
  return id;
}
