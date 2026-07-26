// Desktop (OS) notifications for mail that arrives while the user is AWAY from
// the terminal — the one surface that reaches a genuinely idle user (in-chat
// surfacing still happens on the agent's next engagement; see the boundaries in
// PUSH.md). Fired by the background warmer after a drain that added mail.
//
// ON by default (0.22). The user flips it conversationally ("stop notifying
// me") via the `update_notify` tool → settings.notify, which rides the vault
// like the rest of settings. MESSENGER_NOTIFY=0/1 force-overrides on a single
// device (a headless box, a CI runner) and wins over the setting.
//
// Privacy mirrors the model-facing read paths (0.18):
//   - a HELD (gated "pending") new handle never shows a body — only
//     "n held from new handle <name>", same as the 🆕 card,
//   - a dismissed handle's mail is silent here too (dismissed = quiet by design),
//   - a single fresh message shows sender + a short preview; a batch collapses
//     to counts + names,
//   - while a live chat session runs (chat.lock fresh) nothing fires — the feed
//     already shows mail in real time.
//
// NO terminal bell: on the stdio transport stdout IS the MCP JSON-RPC stream,
// so writing a BEL byte there risks corrupting a frame (the pre-0.22 opt-in
// path did exactly that). The OS notification is the whole signal.

import { execFile } from "node:child_process";
import { loadSettings } from "./settings.ts";
import { unreadFor, type MessageRow } from "./db.ts";
import { senderLabel, contactByKey } from "./contacts.ts";
import { readChatLock, type NetContext } from "./core-net.ts";

export interface NotifyOpts {
  settingsPath: string; // the per-user settings file (settings.notify)
  chatLockPath: string; // chat.lock — a fresh lock means the feed owns surfacing
}

// Ids already announced by this process, so a later drain notifies only for
// genuinely new mail — unread-until-read must not re-count old messages.
const announced = new Set<string>();

// The warmer's entry point. Best-effort by contract: it must never throw into
// a drain, and delivery is fire-and-forget.
export function notifyNewMail(ctx: NetContext, opts: NotifyOpts): void {
  try {
    if (!notifyEnabled(opts.settingsPath)) return;
    if (readChatLock(opts.chatLockPath, ctx.now()).active) return;
    const gate = (m: MessageRow) =>
      m.sender === ctx.me.signPub ? undefined : contactByKey(ctx.book, m.sender)?.gated;
    const fresh = unreadFor(ctx.cache, ctx.me.signPub).filter(
      (m) => !announced.has(m.id) && gate(m) !== "dismissed",
    );
    if (!fresh.length) return;
    fresh.forEach((m) => announced.add(m.id));
    // Self-mail (an escalation from the user's own desk, a note to self) labels
    // like the inbox rider does; everyone else gets the user's nickname.
    const label = (m: MessageRow) =>
      m.sender === ctx.me.signPub
        ? m.answered_by === "assistant"
          ? "your assistant"
          : "Me"
        : senderLabel(ctx.book, m.sender);
    const n = composeNotification(
      fresh.map((m) => ({ from: label(m), body: m.body, held: gate(m) === "pending" })),
    );
    if (n) deliver(n.title, n.body);
  } catch {
    /* a notification must never break a drain */
  }
}

// The effective switch: env force-override first, then the synced preference.
export function notifyEnabled(settingsPath: string): boolean {
  const env = process.env.MESSENGER_NOTIFY;
  if (env === "0") return false;
  if (env === "1") return true;
  return loadSettings(settingsPath).notify;
}

export interface NotifyItem {
  from: string;
  body: string;
  held: boolean; // gated new handle — the body must never be shown
}

// Pure shaping, split out for tests. One fresh normal message → sender + preview;
// anything else collapses to counts + names (held mail contributes NO body text).
export function composeNotification(items: NotifyItem[]): { title: string; body: string } | null {
  const normal = items.filter((i) => !i.held);
  const held = items.filter((i) => i.held);
  if (!normal.length && !held.length) return null;
  if (normal.length === 1 && !held.length) {
    const m = normal[0]!;
    return { title: m.from, body: m.body.replace(/\s+/g, " ").trim().slice(0, 120) };
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  const parts: string[] = [];
  if (normal.length)
    parts.push(
      `${normal.length} new message${normal.length > 1 ? "s" : ""} from ${uniq(normal.map((i) => i.from)).join(", ")}`,
    );
  if (held.length) {
    const names = uniq(held.map((i) => i.from));
    parts.push(
      `${held.length} held from new handle${names.length > 1 ? "s" : ""} ${names.join(", ")}`,
    );
  }
  return { title: "cli-chat", body: parts.join(" · ") };
}

// The Windows toast, via WinRT from PowerShell — no dependency, Win10+. Text
// travels in env vars (never interpolated into the script), so a hostile body
// can't break out. The PowerShell AppId is the standard unregistered-app trick.
const PS_TOAST = [
  "$ErrorActionPreference='SilentlyContinue';",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;",
  "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
  "$x=$t.GetElementsByTagName('text');",
  "$x.Item(0).AppendChild($t.CreateTextNode($env:CLI_CHAT_NOTIFY_TITLE)) > $null;",
  "$x.Item(1).AppendChild($t.CreateTextNode($env:CLI_CHAT_NOTIFY_BODY)) > $null;",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t));",
].join("");

// Fire the platform notifier, fire-and-forget. A sender label is ultimately
// sender-influenced text, so it's sanitised per transport: quotes stripped for
// the AppleScript string, leading dashes stripped so notify-send can't read a
// name as an option, and env-var transport on Windows needs nothing.
function deliver(title: string, body: string): void {
  const t = title.replace(/^-+/, "").trim() || "cli-chat";
  const b = body.replace(/^-+/, "").trim();
  if (process.platform === "darwin") {
    const safe = (s: string) => s.replace(/["\\]/g, " ");
    execFile(
      "osascript",
      ["-e", `display notification "${safe(b)}" with title "${safe(t)}" sound name "Glass"`],
      () => {},
    );
  } else if (process.platform === "linux") {
    execFile("notify-send", ["-a", "cli-chat", t, b], () => {});
  } else if (process.platform === "win32") {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", PS_TOAST],
      {
        env: { ...process.env, CLI_CHAT_NOTIFY_TITLE: t, CLI_CHAT_NOTIFY_BODY: b },
        windowsHide: true,
      },
      () => {},
    );
  }
}
