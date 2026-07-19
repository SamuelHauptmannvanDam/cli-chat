// Single source of truth for the hosted mailbox URL. The mailbox is the
// store-and-forward relay (Cloudflare Worker + D1) that every client talks to.
//
// Default is the hosted worker so a bare `npx cli-chat-mcp` works with no env.
// Override per-process with MESSENGER_MAILBOX_URL — e.g. http://localhost:8787
// when developing against a local mailbox (`npx wrangler dev`).

export const DEFAULT_MAILBOX_URL = "https://mailbox.cli-chat.dev";

export function resolveMailboxUrl(): string {
  return process.env.MESSENGER_MAILBOX_URL?.trim() || DEFAULT_MAILBOX_URL;
}

// The project's own feedback account, seeded into every brand-new account's
// contact book so a new user can immediately "write feedback: …" (the mailbox
// behind it reaches the maintainers). MESSENGER_FEEDBACK_HANDLE overrides the
// handle per-process; set it to the empty string to disable seeding (tests).
export const DEFAULT_FEEDBACK_HANDLE = "FeedBk";
export const FEEDBACK_CONTACT_NAME = "cli-chat feedback";

export function resolveFeedbackHandle(): string {
  return process.env.MESSENGER_FEEDBACK_HANDLE?.trim() ?? DEFAULT_FEEDBACK_HANDLE;
}
