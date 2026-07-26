// The waiting-mail email sweep (NOTIFY-EMAIL.md). Run hourly by the Worker's
// cron: accounts whose mail has sat unfetched for 24h — no device online since
// it arrived — get ONE email per away-stretch (the marker clears on drain).
// Separate from app.ts because scheduled() never builds the Hono app, and Node
// tests drive this directly against nodeSqliteStore.

import type { Store } from "./store.ts";
import { unreadEmail, type SendEmail } from "./email.ts";

export const UNREAD_AGE_MS = 24 * 60 * 60 * 1000;
// Resend free tier is 100/day; overflow candidates simply re-qualify on the
// next hourly run, so the cap costs latency, never mail.
export const MAX_UNREAD_EMAILS_PER_RUN = 50;

export async function sweepUnreadEmails(
  store: Store,
  send: SendEmail,
  now: number,
  opts?: { ageMs?: number; max?: number },
): Promise<number> {
  const ageMs = opts?.ageMs ?? UNREAD_AGE_MS;
  const max = opts?.max ?? MAX_UNREAD_EMAILS_PER_RUN;
  const candidates = await store.unreadEmailCandidates(now - ageMs, max);
  let sent = 0;
  for (const c of candidates) {
    // Send first, mark only on success (the invite pattern): a failed send
    // leaves the marker unset, so the next hourly run retries.
    try {
      await send(unreadEmail(c.email, { count: c.count, senderNames: c.senderNames }));
      await store.markUnreadNotified(c.signPub, now);
      sent++;
    } catch {
      /* best-effort; retried next run */
    }
  }
  return sent;
}
