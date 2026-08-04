// Enforces the one structural rule from docs/ARCHITECTURE.md:
//   - src/core/** must stay platform-agnostic (no Node builtins, no Node-only deps)
//   - server-mailbox/** and online/src/** may only reach into src/ via src/core/
// A plain node:test so it runs on every `npm test` with no extra tooling.
//
// This is a text-level check, not a real module-graph resolver — it can't see
// Node usage hidden inside a third-party or local dependency that src/core/
// imports by package name (only a real bundler, e.g. `npm run build:online`,
// catches that). What it DOES cover, deliberately, because each was a real gap
// found while writing it: comments that merely *mention* "node:" or "../src/"
// (stripped before matching, so they can't false-positive); nested directories
// under the scanned roots (walked recursively, not just top-level files); and
// the `createRequire(import.meta.url)("node:x")` idiom src/db.ts already uses
// to lazy-load a Node-only module — a real Node import that plain `import`/
// `from` scanning would miss (a false negative), so it's matched separately.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

// Recursive so a future subdirectory under a scanned root doesn't silently
// fall outside the check.
function tsFilesIn(dir: string): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesIn(rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

// Comments can legitimately mention "node:" or "../src/" in prose (this
// codebase's comments do, e.g. "unlike node:crypto, we use libsodium") — left
// unstripped, those become false positives. Block comments are removed
// outright; line comments only when "//" is preceded by whitespace/line-start,
// so a "https://" inside a string literal (no preceding whitespace) survives.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

// Covers every shape a real Node/cross-boundary import can take in this repo:
// `import ... from "x"` / `export ... from "x"`, bare `import "x"`, dynamic
// `import("x")`, plain `require("x")`, and the `createRequire(...)("x")`
// idiom (matched by its call-then-call-again shape, since there's no literal
// "require(" token immediately before the string in that form).
const IMPORT_PATTERNS = [
  /from\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\)\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function importSpecifiers(relPath: string): string[] {
  const text = stripComments(readFileSync(join(ROOT, relPath), "utf8"));
  const specifiers: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    const re = new RegExp(pattern);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (spec) specifiers.push(spec);
    }
  }
  return specifiers;
}

// Node-only import surface that src/core/** must never pull in, directly or by
// depending on a package that does.
const NODE_ONLY = /^node:|^node-sqlite3-wasm$/;

test("src/core/** stays platform-agnostic (no Node builtins)", () => {
  const offenders: string[] = [];
  for (const file of tsFilesIn("src/core")) {
    for (const spec of importSpecifiers(file)) {
      if (NODE_ONLY.test(spec)) offenders.push(`${file} imports "${spec}"`);
    }
  }
  assert.deepEqual(offenders, [], `Node-only imports found in src/core/:\n${offenders.join("\n")}`);
});

// server-mailbox/** and online/src/** may only reach into src/ through src/core/.
const CROSS_DIR_RULES: Array<{ dir: string; pattern: RegExp }> = [
  { dir: "server-mailbox", pattern: /^\.\.\/src\/(?!core\/)/ },
  { dir: "online/src", pattern: /^\.\.\/\.\.\/src\/(?!core\/)/ },
];

test("server-mailbox/ and online/src/ only import src/ via src/core/", () => {
  const offenders: string[] = [];
  for (const { dir, pattern } of CROSS_DIR_RULES) {
    for (const file of tsFilesIn(dir)) {
      for (const spec of importSpecifiers(file)) {
        if (pattern.test(spec)) offenders.push(`${file} imports "${spec}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Imports reaching outside src/core/ found:\n${offenders.join("\n")}`,
  );
});
