// Outbound email for the magic-link login. Cloudflare can't send arbitrary email
// (Email Routing is inbound-only), so this is the one piece that reaches a third
// party — Resend by default. It's injected into the Hono app as the `sendEmail`
// dep (like `notify`/`rateLimit`), so Node tests pass a stub that records the
// link instead of sending, and the Worker passes the Resend sender below.

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendEmail = (msg: OutboundEmail) => Promise<void>;

// Build the magic-link email. The link points at the Worker's /auth/verify, which
// the user opens in a browser; clicking it authorizes the waiting CLI session.
export function magicLinkEmail(to: string, link: string): OutboundEmail {
  return {
    to,
    subject: "Your cli-chat login link",
    text:
      `Click to log in to cli-chat and sync this device:\n\n${link}\n\n` +
      `This link is single-use and expires in 15 minutes. If you didn't request ` +
      `it, you can ignore this email.`,
    html:
      `<p>Click to log in to cli-chat and sync this device:</p>` +
      `<p><a href="${link}">Log in to cli-chat</a></p>` +
      `<p style="color:#666;font-size:13px">This link is single-use and expires in ` +
      `15 minutes. If you didn't request it, you can ignore this email.</p>`,
  };
}

// Resend-backed sender for the Worker. `from` must be a verified Resend domain
// (e.g. "cli-chat <login@your-domain.com>"). Throws on a non-2xx so /auth/login
// surfaces a real error rather than silently dropping the link.
export function resendSender(apiKey: string, from: string): SendEmail {
  return async (msg) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`resend send failed: ${res.status} ${detail}`);
    }
  };
}
