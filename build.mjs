// Bundles the runnable entry points from src/*.ts into plain ESM .js under
// dist/, so the package runs on any supported Node (no native TypeScript needed)
// and can be published / run via npx. Only OUR code is bundled; node_modules and
// node: builtins stay external (declared as runtime `dependencies`).
//
//   node build.mjs
//
// Each entry is self-contained (no code splitting) and carries a shebang, so it
// works both as `node dist/<x>.js` and as a directly-executed command.

import { build } from "esbuild";
import { chmodSync } from "node:fs";
import { join } from "node:path";

const entries = [
  "server-net", // the MCP server (the `cli-chat` bin)
  "check-inbox", // SessionStart / UserPromptSubmit hook
  "install", // wires the server into each detected CLI
  "init-identity", // one-shot identity creation
  "add-contact", // CLI contact add
  "migrate", // legacy layout migration
];

await build({
  entryPoints: entries.map((e) => `src/${e}.ts`),
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external", // keep deps + node: builtins as runtime imports
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

// Make the published bins directly executable.
for (const e of entries) chmodSync(join("dist", `${e}.js`), 0o755);
