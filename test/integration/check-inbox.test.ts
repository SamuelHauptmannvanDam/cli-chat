// check-inbox.ts is the SessionStart/UserPromptSubmit/Stop hook. It's a top-level
// script (no exports), so we drive it as a subprocess: a temp MESSENGER_HOME, a
// seeded identity, and a fresh pending.json snapshot let us exercise every output
// branch WITHOUT any crypto or network (the warmer-snapshot path the hook prefers).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const script = join(repoRoot, "src", "check-inbox.ts");
const USER = "dC0v6m";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "clim-hook-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function userDir(): string {
  const d = join(home, "users", USER);
  mkdirSync(d, { recursive: true });
  return d;
}

function seedIdentity(name = "Sam") {
  writeFileSync(
    join(userDir(), "identity.json"),
    JSON.stringify({ boxPub: "bp", boxSec: "bs", signPub: "sp", signSec: "ss", name, handle: USER }),
  );
}

function seedPending(
  messages: Array<{ id: string; from: string; body: string }>,
  ageMs = 0,
  synced = true,
) {
  writeFileSync(
    join(userDir(), "pending.json"),
    JSON.stringify({
      writtenAt: Date.now() - ageMs,
      messages: messages.map((m) => ({ ...m, at: Date.now(), in_reply_to: null })),
      synced,
    }),
  );
}

function seedAck(ids: string[]) {
  writeFileSync(join(userDir(), "pending-ack.json"), JSON.stringify(ids));
}

// Run the hook with the given event, returning parsed stdout (or null when the
// hook stays silent, which is itself a meaningful outcome).
function runHook(
  hookEventName: string,
  extra: Record<string, unknown> = { account: true },
  extraEnv: Record<string, string> = {},
): any {
  const payload = JSON.stringify({ hook_event_name: hookEventName, ...extra });
  const res = spawnSync("node", [script], {
    input: payload,
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MESSENGER_HOME: home,
      MESSENGER_USER: USER,
      MESSENGER_MAILBOX_URL: "", // pending path never hits the network; guard anyway
      ...extraEnv,
    },
  });
  assert.equal(res.status, 0, `exit ${res.status}: ${res.stderr}`);
  const out = res.stdout.trim();
  return out ? JSON.parse(out) : null;
}

test("no account on SessionStart nudges the user to set up", () => {
  // No identity seeded → not set up.
  const out = runHook("SessionStart");
  assert.match(out.systemMessage, /don't have a cli-chat account/);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /create_account/);
});

test("no account on UserPromptSubmit stays silent (no nagging mid-session)", () => {
  const out = runHook("UserPromptSubmit");
  assert.equal(out, null);
});

test("Stop that is already a continuation exits silently (re-entry guard)", () => {
  seedIdentity();
  seedPending([{ id: "m1", from: "Niels", body: "hi" }]);
  const out = runHook("Stop", { stop_hook_active: true });
  assert.equal(out, null);
});

test("fresh pending mail surfaces as a count + offer on SessionStart", () => {
  seedIdentity();
  seedPending([{ id: "m1", from: "Niels", body: "lunch?" }]);
  const out = runHook("SessionStart");
  assert.match(out.systemMessage, /📬 1 new message from Niels/);
  // The body goes to the agent privately, never to the user-facing summary.
  assert.doesNotMatch(out.systemMessage, /lunch\?/);
  assert.match(out.hookSpecificOutput.additionalContext, /\[inbox\]/);
  assert.match(out.hookSpecificOutput.additionalContext, /lunch\?/);
});

test("multiple senders are de-duplicated and pluralised", () => {
  seedIdentity();
  seedPending([
    { id: "m1", from: "Niels", body: "a" },
    { id: "m2", from: "Niels", body: "b" },
    { id: "m3", from: "Bob", body: "c" },
  ]);
  const out = runHook("SessionStart");
  assert.match(out.systemMessage, /3 new messages from Niels, Bob/);
});

test("already-acked ids are not re-announced", () => {
  seedIdentity();
  seedPending([
    { id: "m1", from: "Niels", body: "old" },
    { id: "m2", from: "Niels", body: "new" },
  ]);
  seedAck(["m1"]); // m1 already surfaced on a prior run
  const out = runHook("SessionStart");
  assert.match(out.systemMessage, /1 new message from Niels/);
  assert.match(out.hookSpecificOutput.additionalContext, /new/);
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /id m1/);
});

test("mail arriving on Stop blocks the stop so the agent can relay it", () => {
  seedIdentity();
  seedPending([{ id: "m1", from: "Niels", body: "ping" }]);
  const out = runHook("Stop");
  assert.equal(out.decision, "block");
  assert.match(out.systemMessage, /📬 1 new message from Niels/);
  // The block `reason` is rendered ON SCREEN, so it must stay lean: tell the agent
  // to relay, reference the id for an on-demand re-fetch — and NOT leak the body.
  assert.doesNotMatch(out.reason, /ping/);
  assert.match(out.reason, /read_message/);
  assert.match(out.reason, /m1/);
});

test("no mail on SessionStart still hands the agent its identity", () => {
  seedIdentity("Sam");
  seedPending([]); // fresh snapshot, nothing waiting
  const out = runHook("SessionStart");
  assert.equal(out.systemMessage, undefined); // no count, no nudge
  assert.match(out.hookSpecificOutput.additionalContext, /messenger for Sam \(their code is dC0v6m\)/);
});

test("a placeholder name triggers the one-time name ask", () => {
  seedIdentity(USER); // name === handle → placeholder
  seedPending([]);
  const out = runHook("SessionStart");
  assert.match(out.systemMessage, /You haven't set a name yet/);
  assert.match(out.hookSpecificOutput.additionalContext, /NOT set a display name/);
});

test("no mail on UserPromptSubmit produces no output", () => {
  seedIdentity("Sam");
  seedPending([]);
  const out = runHook("UserPromptSubmit");
  assert.equal(out, null);
});

test("SessionStart waits past a seed-only snapshot before deciding (cold-open race)", () => {
  // synced:false is the warmer's boot seed, written before its first network
  // drain. The hook must wait for a synced snapshot rather than trust the seed —
  // bounded by MESSENGER_COLD_OPEN_MS. No warmer runs here, so it waits the full
  // window (kept short for the test) then surfaces whatever the seed holds.
  seedIdentity("Sam");
  seedPending([{ id: "m1", from: "Niels", body: "ping" }], 0, false);
  const t0 = Date.now();
  const out = runHook("SessionStart", { account: true }, { MESSENGER_COLD_OPEN_MS: "400" });
  assert.ok(Date.now() - t0 >= 400, "should wait the cold-open window for a synced snapshot");
  assert.match(out.systemMessage, /📬 1 new message from Niels/); // still surfaces the seed on timeout
});

test("SessionStart does not wait when a synced snapshot is already present", () => {
  seedIdentity("Sam");
  seedPending([{ id: "m1", from: "Niels", body: "ping" }], 0, true);
  const t0 = Date.now();
  const out = runHook("SessionStart", { account: true }, { MESSENGER_COLD_OPEN_MS: "5000" });
  assert.ok(Date.now() - t0 < 2000, "a synced snapshot is trusted immediately, no wait");
  assert.match(out.systemMessage, /📬 1 new message from Niels/);
});
