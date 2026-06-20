// Cross-CLI installer. Registers the cli-chat MCP server with whichever
// agent CLIs are present on this machine — each has its own config format, but
// they all just run a stdio command. Behavior travels via the server's MCP
// `instructions`, so no per-CLI prompt file is required.
//
//   node src/install.ts   (or: npm run install-clis)   # from a clone
//
// The registered command is `npx -y cli-chat-mcp`, so the target CLI always
// runs the published package — no repo checkout or build needed on that machine.
// Identity lives in ~/.cli-chat (created on first use via create_account), so
// MESSENGER_USER is optional; set it only to pin a specific identity by name.
//
// Idempotent: re-running updates the entry. Prints a manual snippet for any CLI
// it can't detect.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = process.env.HOME_OVERRIDE ?? homedir(); // HOME_OVERRIDE for testing
const PKG = "cli-chat-mcp"; // the published npm package run via npx
const NAME = "cli-chat"; // the server key shown in each CLI's config

const user = process.env.MESSENGER_USER; // optional: pin a named identity
const mailboxUrl =
  process.env.MESSENGER_MAILBOX_URL ??
  "https://cli-chat.samuelhauptmannvandam.workers.dev";

const env: Record<string, string> = { MESSENGER_MAILBOX_URL: mailboxUrl };
if (user) env.MESSENGER_USER = user;

const spec = {
  command: "npx",
  args: ["-y", PKG],
  env,
};

const results: string[] = [];
const ok = (cli: string, detail: string) => results.push(`✓ ${cli}: ${detail}`);
const skip = (cli: string, detail: string) => results.push(`– ${cli}: ${detail}`);

function onPath(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Merge our entry into a JSON config file's mcpServers map, preserving the rest.
function mergeJsonMcp(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let cfg: any = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`existing ${path} is not valid JSON — left untouched`);
    }
  }
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers[NAME] = spec;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

// --- Claude Code: use the official CLI when present (schema-safe) -----------
if (onPath("claude")) {
  try {
    const envFlags =
      `--env MESSENGER_MAILBOX_URL=${mailboxUrl}` +
      (user ? ` --env MESSENGER_USER=${user}` : "");
    execSync(
      `claude mcp add ${NAME} --scope user ${envFlags} -- npx -y ${PKG}`,
      { stdio: "ignore" },
    );
    ok("Claude Code", "registered (user scope) via `claude mcp add`");
  } catch {
    skip("Claude Code", "`claude mcp add` failed; add the manual block below");
  }
} else {
  skip("Claude Code", "`claude` not on PATH; add the manual block below");
}

// --- Gemini CLI: ~/.gemini/settings.json ------------------------------------
const geminiDir = join(HOME, ".gemini");
if (existsSync(geminiDir) || onPath("gemini")) {
  try {
    mergeJsonMcp(join(geminiDir, "settings.json"));
    ok("Gemini CLI", "wrote ~/.gemini/settings.json");
  } catch (e) {
    skip("Gemini CLI", (e as Error).message);
  }
} else {
  skip("Gemini CLI", "not detected");
}

// --- Cursor: ~/.cursor/mcp.json ---------------------------------------------
const cursorDir = join(HOME, ".cursor");
if (existsSync(cursorDir) || onPath("cursor")) {
  try {
    mergeJsonMcp(join(cursorDir, "mcp.json"));
    ok("Cursor", "wrote ~/.cursor/mcp.json");
  } catch (e) {
    skip("Cursor", (e as Error).message);
  }
} else {
  skip("Cursor", "not detected");
}

// --- Codex CLI: ~/.codex/config.toml (TOML — append a block) ----------------
const codexDir = join(HOME, ".codex");
if (existsSync(codexDir) || onPath("codex")) {
  try {
    const tomlPath = join(codexDir, "config.toml");
    mkdirSync(codexDir, { recursive: true });
    const envToml = user
      ? `{ MESSENGER_USER = ${JSON.stringify(user)}, MESSENGER_MAILBOX_URL = ${JSON.stringify(mailboxUrl)} }`
      : `{ MESSENGER_MAILBOX_URL = ${JSON.stringify(mailboxUrl)} }`;
    const block =
      `\n[mcp_servers.${NAME}]\n` +
      `command = "npx"\n` +
      `args = ["-y", ${JSON.stringify(PKG)}]\n` +
      `env = ${envToml}\n`;
    const existing = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
    if (existing.includes(`[mcp_servers.${NAME}]`)) {
      skip("Codex CLI", "already present in ~/.codex/config.toml (left as-is)");
    } else {
      writeFileSync(tomlPath, existing + block);
      ok("Codex CLI", "appended to ~/.codex/config.toml");
    }
  } catch (e) {
    skip("Codex CLI", (e as Error).message);
  }
} else {
  skip("Codex CLI", "not detected");
}

console.log(`\ncli-chat install — package ${PKG}, mailbox ${mailboxUrl}\n`);
console.log(results.join("\n"));
console.log(
  `\nManual config (any MCP-capable CLI) — register a stdio server:\n` +
    `  command: npx\n  args:    ["-y", "${PKG}"]\n` +
    `  env:     MESSENGER_MAILBOX_URL=${mailboxUrl}` +
    (user ? `, MESSENGER_USER=${user}` : "") +
    `\n\nRestart each CLI to pick it up, then say "set me up" to get your code.`,
);
