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

// Build the one-ever invite email (EMAIL-SEND.md): sent the FIRST time anyone
// writes to an email that has no cli-chat account, and never again — no
// reminders, no digests, silence is the only follow-up. Carries the sender's
// display name and nothing of the message (it's sealed; we couldn't include it
// and wouldn't). `senderName` is a self-chosen display name — untrusted, so the
// HTML variant escapes it.
export function inviteEmail(to: string, senderName: string | null): OutboundEmail {
  const who = senderName?.trim() || "Someone";
  const esc = who.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return {
    to,
    subject: `${who} has a message waiting for you on cli-chat`,
    text:
      `One-time invite — we only send this once.\n\n` +
      `${who} sent you an encrypted message on cli-chat — messaging for coding-agent ` +
      `CLIs. It's waiting for you: install cli-chat (https://cli-chat.dev), tell your ` +
      `agent to log in with this email address, and the message is there.\n\n` +
      `Ignore this and you'll never hear from us again — later messages just wait quietly.`,
    html:
      `<p><b>One-time invite</b> — we only send this once.</p>` +
      `<p><b>${esc}</b> sent you an encrypted message on <a href="https://cli-chat.dev">cli-chat</a> ` +
      `— messaging for coding-agent CLIs.</p>` +
      `<p>It's waiting for you: install cli-chat, tell your agent to log in with this ` +
      `email address, and the message is there.</p>` +
      `<p style="color:#666;font-size:13px">Ignore this and you'll never hear from us ` +
      `again — later messages just wait quietly.</p>`,
  };
}

// Build the waiting-mail email (NOTIFY-EMAIL.md): sent to an ACCOUNT holder when
// mail has sat unfetched for 24h — no device of theirs has been online since it
// arrived. Once per away-stretch: after this sends, silence until they come
// online again. Counts + sender display names only; bodies are sealed (we
// couldn't include them and wouldn't). Names are self-chosen — untrusted, so the
// HTML variant escapes them.
export function unreadEmail(
  to: string,
  info: { count: number; senderNames: (string | null)[] },
): OutboundEmail {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const names = [...new Set(info.senderNames.map((n) => n?.trim()).filter((n): n is string => !!n))];
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  const fromWho =
    shown.length === 0
      ? ""
      : ` from ${shown.join(", ")}${extra > 0 ? ` and ${extra} other${extra === 1 ? "" : "s"}` : ""}`;
  const n = info.count;
  const subject =
    n === 1 && shown.length === 1
      ? `${shown[0]} is waiting on you on cli-chat`
      : `You have ${n} message${n === 1 ? "" : "s"} waiting on cli-chat`;
  const footer =
    `Messages wait up to 30 days. We email at most once per absence — you won't ` +
    `hear from us again until you've picked up your mail and new messages pile up. ` +
    `To turn these emails off, tell your agent: "stop emailing me about waiting mail".`;
  return {
    to,
    subject,
    text:
      `You have ${n} unread message${n === 1 ? "" : "s"}${fromWho} waiting in your ` +
      `cli-chat inbox — encrypted, so only your device can read ${n === 1 ? "it" : "them"}.\n\n` +
      `Open your agent CLI and ask it to read your messages.\n\n` +
      footer,
    html:
      `<p>You have <b>${n} unread message${n === 1 ? "" : "s"}</b>${esc(fromWho)} waiting in your ` +
      `<a href="https://cli-chat.dev">cli-chat</a> inbox — encrypted, so only your device can read ` +
      `${n === 1 ? "it" : "them"}.</p>` +
      `<p>Open your agent CLI and ask it to read your messages.</p>` +
      `<p style="color:#666;font-size:13px">${esc(footer)}</p>`,
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
