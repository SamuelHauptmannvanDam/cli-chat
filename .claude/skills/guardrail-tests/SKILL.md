---
name: guardrail-tests
description: Guidelines for writing text/regex-based guardrail tests in this repo (import-boundary checks, structural rules enforced via a plain node:test instead of a linter/dependency-cruiser). Use when adding a new architectural rule that should be checked automatically, or when reviewing/debugging an existing guardrail test like test/unit/boundaries.test.ts.
---

# Writing guardrail tests

This repo enforces structural rules (e.g. "`src/core/` must stay platform-agnostic",
"`server-mailbox/` and `online/src/` may only import `src/core/`") with plain
`node:test` files that grep source text for import specifiers — not a linter or
`dependency-cruiser`. That keeps the guardrail dependency-free and runnable via
the existing `npm test`, but it means the check is pattern-matching text, not
parsing a real AST. Every regex-based guardrail test in this repo should be
audited against the false-positive/false-negative list below before it's
trusted. `test/unit/boundaries.test.ts` is the reference implementation — read
it alongside this skill.

## The core tension

A regex-based check trades soundness for zero dependencies. That trade is fine
for a small codebase, but only if you actively close the gaps a real parser
would catch for free. Two failure directions, and both are worse than no check
at all if unaddressed — a false negative gives false confidence, a false
positive trains people to ignore the test's failures.

## False positives to guard against (test fails on code that's actually fine)

- **Comments mentioning the forbidden thing in prose.** This codebase is
  comment-heavy and its comments frequently *name* the very modules a rule
  forbids (e.g. "unlike `node:crypto`, we use libsodium" inside a file that must
  never *import* `node:crypto`). If your matcher runs on raw file text, it WILL
  match this. Fix: strip comments before matching (`stripComments` in
  `boundaries.test.ts` — block comments removed outright; line comments only
  when `//` is preceded by whitespace/line-start, so `"https://..."` inside a
  string literal survives).
- **Substrings inside unrelated string literals.** A regex that matches
  `node:` anywhere, rather than only inside an actual import specifier position
  (`from "..."`, `import "..."`, `import("...")`), will flag URLs, log strings,
  error messages. Anchor the match to the syntactic shapes real imports take,
  not a bare substring search.
- **Verify the fix, not just the intent.** After writing a comment-stripper or
  an anchor pattern, actually inject a fixture that would have false-positived
  under the naive version and confirm the hardened version passes it. "I added
  stripping" is not evidence; a green run on the adversarial fixture is.

## False negatives to guard against (test passes on code that's actually broken)

- **Non-`import`/`from` ways to pull in a module.** `require("x")` and, in this
  codebase specifically, the `createRequire(import.meta.url)("node:sqlite")`
  idiom (`src/db.ts` uses exactly this to lazy-load a Node-only driver) are
  real value-imports that a matcher scoped to `import`/`from` syntax will miss
  entirely. If the codebase uses an idiom like this anywhere, the guardrail
  must match it too — match on the call *shape* (e.g. `)( "spec" )`) if there's
  no literal keyword to anchor on.
- **Non-recursive directory scanning.** A rule scoped to "everything under
  `src/core/`" must actually walk subdirectories. A flat `readdirSync` that
  only sees top-level files silently stops enforcing the rule the moment
  someone organizes the folder into subdirectories — the most likely time
  someone would *also* introduce a violation, since they're restructuring.
  Walk recursively from the start, even if the directory is flat today.
  (`tsFilesIn` in `boundaries.test.ts`.)
- **Dynamic import forms.** `import("...")` (async/lazy import) is easy to
  forget alongside static `import ... from "..."` — grep the codebase for all
  the shapes an import actually takes (`grep -rn "import("`) before assuming
  static `import`/`from` covers everything.
- **What text-matching fundamentally cannot see: transitive imports through a
  third-party or local package.** If `src/core/x.ts` imports an npm package
  by name, and that package internally uses `node:fs`, no text scan of the
  repo's own `.ts` files will ever catch it — the Node usage lives inside
  `node_modules`. State this limitation explicitly in the test file's own
  header comment rather than pretending the check is a complete answer; the
  actual backstop for this class of bug is the real bundler run
  (`npm run build:online`), which fails to resolve a Node builtin in a
  browser build. A regex guardrail is a fast first line of defense, not a
  replacement for exercising the real build.

## Workflow when adding a new guardrail test

1. **Write the rule and the naive matcher first** — get the happy path green.
2. **Grep the codebase for every real shape the forbidden/required pattern
   could take** (`import`, `export ... from`, dynamic `import(`, `require(`,
   any project-specific idiom like `createRequire`). Don't guess from memory —
   this repo has already demonstrated an idiom (`db.ts`'s `createRequire`
   lazy-load) that a "just match `import`/`from`" scanner misses.
3. **Grep existing files for prose that could collide with the pattern**
   (comments naming the forbidden module, string literals containing the
   substring). If any exist, your matcher already has a live false-positive
   risk — harden it before relying on the test.
4. **Sanity-check both directions with injected fixtures**, then revert:
   - inject a real violation → confirm the test fails
   - inject an innocent comment/string mentioning the same substring → confirm
     the test still passes
   - if the rule scopes a directory, add a file in a nested subdirectory →
     confirm it's still checked
   Do this every time you touch the matcher, not just once at authoring time —
   a "simplification" of the regex later is exactly how a guardrail quietly
   stops guarding.
5. **Document the check's actual limits** in a header comment (what it cannot
   see, e.g. transitive dependency behavior) so nobody mistakes "the guardrail
   test is green" for "the rule is fully enforced."
