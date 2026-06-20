// Cross-CLI installer. Registers the cli-chat MCP server with whichever
// agent CLIs are present on this machine — each has its own config format, but
// they all just run a stdio command. Behavior travels via the server's MCP
// `instructions`, so no per-CLI prompt file is required.
//
//   export MESSENGER_USER=sam
//   node src/install.ts
//
// Idempotent: re-running updates the entry. Prints a manual snippet for any CLI
// it can't detect.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOME = process.env.HOME_OVERRIDE ?? homedir(); // HOME_OVERRIDE for testing
const NAME = "cli-chat";

const user = process.env.MESSENGER_USER;
if (!user) {
  console.error("Set MESSENGER_USER first, e.g.  export MESSENGER_USER=sam");
  process.exit(1);
}
const mailboxUrl =
  process.env.MESSENGER_MAILBOX_URL ??
  "https://cli-chat.samuelhauptmannvandam.workers.dev";
const serverPath = join(ROOT, "src", "server-net.ts");

const spec = {
  command: "node",
  args: [serverPath],
  env: { MESSENGER_USER: user, MESSENGER_MAILBOX_URL: mailboxUrl },
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
    execSync(
      `claude mcp add ${NAME} --scope user ` +
        `--env MESSENGER_USER=${user} --env MESSENGER_MAILBOX_URL=${mailboxUrl} ` +
        `-- node ${JSON.stringify(serverPath)}`,
      { stdio: "ignore" },
    );
    ok("Claude Code", "registered (user scope) via `claude mcp add`");
  } catch {
    // Fall back to the project-scoped .mcp.json that ships with the repo.
    skip("Claude Code", "`claude mcp add` failed; project .mcp.json still works");
  }
} else {
  skip("Claude Code", "`claude` not on PATH; use the repo's .mcp.json");
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
    const block =
      `\n[mcp_servers.${NAME}]\n` +
      `command = "node"\n` +
      `args = [${JSON.stringify(serverPath)}]\n` +
      `env = { MESSENGER_USER = ${JSON.stringify(user)}, MESSENGER_MAILBOX_URL = ${JSON.stringify(mailboxUrl)} }\n`;
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

console.log(`\ncli-chat install — identity "${user}", mailbox ${mailboxUrl}\n`);
console.log(results.join("\n"));
console.log(
  `\nManual config (any MCP-capable CLI) — register a stdio server:\n` +
    `  command: node\n  args:    [${serverPath}]\n` +
    `  env:     MESSENGER_USER=${user}, MESSENGER_MAILBOX_URL=${mailboxUrl}\n` +
    `\nRestart each CLI to pick it up. Behavior is built into the server.`,
);
