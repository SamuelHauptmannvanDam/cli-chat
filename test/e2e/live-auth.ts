// End-to-end proof of the online account (AUTH-SYNC.md): two SEPARATE devices
// (two MESSENGER_HOME dirs) sharing one account. Device A logs in and pushes its
// identity + tagged contacts up; fresh device B logs in and is fully RESTORED
// from the server — same keys, same contacts, same tags. Drives the real client
// (account-client + vault-sync + vault) against a real in-process mailbox, with
// the magic link "clicked" via the dev link and accounts force-paid (no Stripe).
//
// Run: npm run test:auth

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveFetch } from "../serve-fetch.ts";
import { createApp } from "../../server-mailbox/app.ts";
import { nodeSqliteStore } from "../../server-mailbox/store.ts";
import { initCrypto, generateIdentity } from "../../src/core/crypto.ts";
import { createAccountClient } from "../../src/core/account-client.ts";
import { syncVault } from "../../src/vault-sync.ts";
import { applyVault } from "../../src/vault.ts";
import { saveSession } from "../../src/session.ts";

await initCrypto();
const now = () => Date.now();
const EMAIL = "sam@example.com";

// --- mailbox with dev email + every account auto-paid (no Stripe in dev) -----
const store = nodeSqliteStore(":memory:");
const paidStore = new Proxy(store, {
  get(target, prop) {
    if (prop === "getOrCreateAccount")
      return (email: string, n: number) => {
        const a = target.getOrCreateAccount(email, n) as any;
        target.setAccountPaid(a.id, n);
        return { ...a, paid: true };
      };
    if (prop === "accountBySession")
      return (h: string, n: number) => {
        const a = target.accountBySession(h, n) as any;
        return a ? { ...a, paid: true } : a;
      };
    return (target as any)[prop];
  },
});
const app = createApp({ store: paidStore as any, now, exposeMagicLink: true });
const srv = await serveFetch(app.fetch);
const client = createAccountClient(srv.url);

// Drive a full magic-link login, returning the session token.
async function login(): Promise<string> {
  const start = await client.startLogin(EMAIL);
  await fetch(start.devLink!); // "click" the emailed link
  const ready = await client.poll(start.poll_id);
  if (ready.status !== "ready") throw new Error(`login not ready: ${ready.status}`);
  return ready.session_token;
}

const homeA = mkdtempSync(join(tmpdir(), "cli-auth-A-"));
const homeB = mkdtempSync(join(tmpdir(), "cli-auth-B-"));
try {
  // === DEVICE A: existing account, pushes its state online =================
  process.env.MESSENGER_HOME = homeA;
  const id = generateIdentity();
  id.handle = "DEVAAA";
  id.name = "Sam";
  const HANDLE = id.handle;
  mkdirSync(join(homeA, "users", HANDLE), { recursive: true });
  writeFileSync(join(homeA, "users", HANDLE, "identity.json"), JSON.stringify(id));
  writeFileSync(
    join(homeA, "users", HANDLE, "contacts.json"),
    JSON.stringify({
      me: id.signPub,
      contacts: [{ name: "Niels", signPub: "11", boxPub: "22", tags: ["work"] }],
    }),
  );
  writeFileSync(join(homeA, "users", HANDLE, "settings.json"), JSON.stringify({ tagMode: "auto" }));

  const tokenA = await login();
  saveSession(HANDLE, tokenA, EMAIL, now());
  const pushed = await syncVault(client, tokenA, HANDLE, id.signPub, 0, true);
  assert.equal(pushed.action, "pushed", "device A should push its state up");
  console.log(`✓ device A pushed account (vault v${(pushed as any).version})`);

  // === DEVICE B: fresh machine, nothing local, restores from server ========
  process.env.MESSENGER_HOME = homeB;
  const tokenB = await login();
  const pulled = await client.pullVault(tokenB);
  if (pulled === "payment_required" || pulled === "unauthorized" || pulled.blob == null)
    throw new Error(`device B could not pull a vault: ${JSON.stringify(pulled)}`);
  const handleB = applyVault(pulled.blob);
  assert.equal(handleB, HANDLE, "device B restores the same handle");

  // The restored device has the identical identity (incl. private keys) ...
  const idB = JSON.parse(readFileSync(join(homeB, "users", HANDLE, "identity.json"), "utf8"));
  assert.equal(idB.signSec, id.signSec, "private signing key restored");
  assert.equal(idB.boxSec, id.boxSec, "private box key restored");
  // ... and the identical contacts + tags.
  const cbB = JSON.parse(readFileSync(join(homeB, "users", HANDLE, "contacts.json"), "utf8"));
  assert.equal(cbB.contacts[0].name, "Niels");
  assert.deepEqual(cbB.contacts[0].tags, ["work"], "tags came across");
  console.log(`✓ device B restored identity + contacts + tags from the server`);

  console.log("\n✅ multi-device sync works end to end");
} finally {
  srv.close();
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
  delete process.env.MESSENGER_HOME;
}
