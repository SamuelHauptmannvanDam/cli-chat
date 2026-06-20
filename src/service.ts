// Cross-OS background-service control for the watcher. Installs a per-user
// service that runs src/watch.ts on login and keeps it alive, so mail is pulled
// + you're notified without keeping a terminal open — under any CLI.
//
// macOS:   launchd LaunchAgent  (fully implemented + tested)
// Linux:   systemd --user unit  (generated; untested here)
// Windows: Task Scheduler        (generated; untested here)

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceOpts {
  user: string;
  mailboxUrl: string;
  watchPath: string;
  nodePath: string; // absolute path to the node binary
}

export interface ServiceResult {
  ok: boolean;
  message: string;
}

const HOME = process.env.HOME_OVERRIDE ?? homedir();
const label = (user: string) => `com.cli-chat.${user}`;

// ---- macOS (launchd) -------------------------------------------------------
function macPlistPath(user: string): string {
  return join(HOME, "Library", "LaunchAgents", `${label(user)}.plist`);
}

function macPlist(o: ServiceOpts): string {
  const logDir = join(HOME, "Library", "Logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(o.user)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${o.nodePath}</string>
    <string>${o.watchPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MESSENGER_USER</key><string>${o.user}</string>
    <key>MESSENGER_MAILBOX_URL</key><string>${o.mailboxUrl}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, `${label(o.user)}.log`)}</string>
  <key>StandardErrorPath</key><string>${join(logDir, `${label(o.user)}.log`)}</string>
</dict>
</plist>
`;
}

function macInstall(o: ServiceOpts): ServiceResult {
  const path = macPlistPath(o.user);
  mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(HOME, "Library", "Logs"), { recursive: true });
  writeFileSync(path, macPlist(o));
  try {
    execFileSync("launchctl", ["unload", path], { stdio: "ignore" });
  } catch {
    /* not loaded yet — fine */
  }
  execFileSync("launchctl", ["load", "-w", path]);
  return { ok: true, message: `Auto-delivery ON (launchd). Polling in the background for "${o.user}".` };
}

function macUninstall(user: string): ServiceResult {
  const path = macPlistPath(user);
  if (!existsSync(path)) return { ok: true, message: "Auto-delivery was already off." };
  try {
    execFileSync("launchctl", ["unload", "-w", path], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  rmSync(path, { force: true });
  return { ok: true, message: "Auto-delivery OFF (launchd agent removed)." };
}

function macStatus(user: string): ServiceResult {
  const installed = existsSync(macPlistPath(user));
  let running = false;
  try {
    running = execSync(`launchctl list`).toString().includes(label(user));
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    message: installed
      ? `Auto-delivery is ${running ? "ON and running" : "installed (not currently running)"}.`
      : "Auto-delivery is OFF.",
  };
}

// ---- Linux (systemd --user) -----------------------------------------------
function linuxUnitPath(user: string): string {
  return join(HOME, ".config", "systemd", "user", `cli-chat-${user}.service`);
}

function linuxInstall(o: ServiceOpts): ServiceResult {
  const path = linuxUnitPath(o.user);
  mkdirSync(join(HOME, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(
    path,
    `[Unit]
Description=cli-chat background watcher (${o.user})
[Service]
ExecStart=${o.nodePath} ${o.watchPath}
Environment=MESSENGER_USER=${o.user}
Environment=MESSENGER_MAILBOX_URL=${o.mailboxUrl}
Restart=always
[Install]
WantedBy=default.target
`,
  );
  try {
    execSync(`systemctl --user daemon-reload && systemctl --user enable --now cli-chat-${o.user}.service`);
    return {
      ok: true,
      message:
        `Auto-delivery ON (systemd). For it to run while logged out: ` +
        `\`loginctl enable-linger $USER\`.`,
    };
  } catch (e) {
    return { ok: false, message: `Wrote unit to ${path}, but enabling failed: ${(e as Error).message}` };
  }
}

function linuxUninstall(user: string): ServiceResult {
  try {
    execSync(`systemctl --user disable --now cli-chat-${user}.service`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  rmSync(linuxUnitPath(user), { force: true });
  return { ok: true, message: "Auto-delivery OFF (systemd unit removed)." };
}

function linuxStatus(user: string): ServiceResult {
  try {
    const out = execSync(`systemctl --user is-active cli-chat-${user}.service`).toString().trim();
    return { ok: true, message: `Auto-delivery: ${out}.` };
  } catch {
    return { ok: true, message: "Auto-delivery is OFF." };
  }
}

// ---- Windows (Task Scheduler) ---------------------------------------------
function winTask(user: string): string {
  return `cli-chat-${user}`;
}

function winInstall(o: ServiceOpts): ServiceResult {
  // Runs at logon; watch.ts loops internally. Env is set via a wrapper cmd.
  const cmd =
    `set MESSENGER_USER=${o.user}&& set MESSENGER_MAILBOX_URL=${o.mailboxUrl}&& ` +
    `"${o.nodePath}" "${o.watchPath}"`;
  try {
    execSync(
      `schtasks /Create /F /TN "${winTask(o.user)}" /SC ONLOGON /TR "cmd /c ${cmd}"`,
      { stdio: "ignore" },
    );
    return { ok: true, message: "Auto-delivery ON (Task Scheduler, runs at logon)." };
  } catch (e) {
    return { ok: false, message: `Task Scheduler install failed: ${(e as Error).message}` };
  }
}

function winUninstall(user: string): ServiceResult {
  try {
    execSync(`schtasks /Delete /F /TN "${winTask(user)}"`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  return { ok: true, message: "Auto-delivery OFF (scheduled task removed)." };
}

function winStatus(user: string): ServiceResult {
  try {
    execSync(`schtasks /Query /TN "${winTask(user)}"`, { stdio: "ignore" });
    return { ok: true, message: "Auto-delivery is ON (scheduled task present)." };
  } catch {
    return { ok: true, message: "Auto-delivery is OFF." };
  }
}

// ---- dispatch --------------------------------------------------------------
export function enableService(o: ServiceOpts): ServiceResult {
  if (process.platform === "darwin") return macInstall(o);
  if (process.platform === "linux") return linuxInstall(o);
  if (process.platform === "win32") return winInstall(o);
  return { ok: false, message: `Unsupported platform: ${process.platform}` };
}

export function disableService(user: string): ServiceResult {
  if (process.platform === "darwin") return macUninstall(user);
  if (process.platform === "linux") return linuxUninstall(user);
  if (process.platform === "win32") return winUninstall(user);
  return { ok: false, message: `Unsupported platform: ${process.platform}` };
}

export function statusService(user: string): ServiceResult {
  if (process.platform === "darwin") return macStatus(user);
  if (process.platform === "linux") return linuxStatus(user);
  if (process.platform === "win32") return winStatus(user);
  return { ok: false, message: `Unsupported platform: ${process.platform}` };
}
