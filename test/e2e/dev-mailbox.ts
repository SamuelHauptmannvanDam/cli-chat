// A long-lived LOCAL mailbox for hands-on testing of the online account
// (AUTH-SYNC.md) — the thing to point the real MCP server at while you drive
// `login` / `sync` from your CLI. It runs the production Hono app, but in DEV
// mode so you don't need Resend or Stripe:
//   • magic-link emails are PRINTED to this console (and returned as devLink),
//   • every account is auto-marked PAID, so the one-time unlock is bypassed.
// Data is in-memory and vanishes on exit — a fresh slate each run.
//
// Run:   npm run dev:mailbox            (listens on http://localhost:8787)
// Then, in another terminal, start the MCP server against it:
//        MESSENGER_MAILBOX_URL=http://localhost:8787 MESSENGER_HOME=/tmp/cli-dev-A node src/server-net.ts
// and tell the agent "log in with sam@example.com" — the link prints HERE; open
// it, then have the agent finish the login. Repeat with a different MESSENGER_HOME
// to simulate a second device that restores the account.

import { serveFetch } from "../serve-fetch.ts";
import { createApp } from "../../server-mailbox/app.ts";
import { nodeSqliteStore } from "../../server-mailbox/store.ts";
import { initCrypto } from "../../src/crypto.ts";
import { magicLinkEmail } from "../../server-mailbox/email.ts";

await initCrypto();
const PORT = Number(process.env.PORT ?? 8787);
const now = () => Date.now();

// Auto-pay every account so the paid gate doesn't block local testing.
const base = nodeSqliteStore(":memory:");
const store = new Proxy(base, {
  get(t, prop) {
    if (prop === "getOrCreateAccount")
      return (email: string, n: number) => {
        const a = t.getOrCreateAccount(email, n) as any;
        t.setAccountPaid(a.id, n);
        return { ...a, paid: true };
      };
    if (prop === "accountBySession")
      return (h: string, n: number) => {
        const a = t.accountBySession(h, n) as any;
        return a ? { ...a, paid: true } : a;
      };
    return (t as any)[prop];
  },
});

const app = createApp({
  store: store as any,
  now,
  appBaseUrl: `http://localhost:${PORT}`,
  exposeMagicLink: true, // the login response also carries devLink
  // Print the link so you can click it like a real email.
  sendEmail: async (msg) => {
    const link = /href="([^"]+)"/.exec(msg.html)?.[1] ?? msg.text;
    console.log(`\n📧  Magic link for ${msg.to}:\n    ${link}\n`);
  },
});

// Keep `magicLinkEmail` referenced so the import documents the email shape.
void magicLinkEmail;

const srv = await serveFetch(app.fetch, PORT);
console.log(`dev mailbox (auto-paid, dev email) listening on ${srv.url}`);
console.log(`point the MCP server at it:  MESSENGER_MAILBOX_URL=${srv.url}`);
console.log("Ctrl-C to stop.\n");
