// Regression tests for the login dead-end: a brand-new email authenticated,
// got parked on `need_name`, and lost its one-shot session when the process
// restarted — leaving that email permanently un-onboardable. The park has to
// survive a restart, which means surviving on disk.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parkLogin,
  readParkedLogin,
  clearParkedLogin,
  PARKED_LOGIN_TTL_MS,
} from "../../src/pending-login.ts";
import { pendingLoginFile } from "../../src/paths.ts";

const NOW = 1_700_000_000_000;
const ACCOUNT = { email: "daniel@example.com", paid: false, hasVault: false };

let prevHome: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.MESSENGER_HOME;
  home = mkdtempSync(join(tmpdir(), "clim-plogin-"));
  process.env.MESSENGER_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MESSENGER_HOME;
  else process.env.MESSENGER_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

test("nothing parked reads back as null", () => {
  assert.equal(readParkedLogin("poll-1", NOW), null);
});

test("a parked login reads back with its token and account", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  const p = readParkedLogin<typeof ACCOUNT>("poll-1", NOW);
  assert.ok(p, "expected the parked login to be found");
  assert.equal(p.token, "sess-tok");
  assert.equal(p.account.email, "daniel@example.com");
});

// THE regression: this is what a restart between "what's your name?" and the
// answer looks like — a brand-new process reading state it never wrote.
test("a parked login survives a process restart (it is on disk, not in memory)", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  assert.ok(existsSync(pendingLoginFile()), "the park must be a real file");
  // A fresh process has no module state — only the file. Reading it back with no
  // prior park() call in this scope is exactly that situation.
  const p = readParkedLogin<typeof ACCOUNT>("poll-1", NOW);
  assert.ok(p);
  assert.equal(p.token, "sess-tok");
});

test("a different poll_id never adopts someone else's parked session", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  assert.equal(readParkedLogin("poll-2", NOW), null);
});

test("a park past its TTL is ignored", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  assert.equal(readParkedLogin("poll-1", NOW + PARKED_LOGIN_TTL_MS + 1), null);
});

test("a park just inside its TTL still works", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  assert.ok(readParkedLogin("poll-1", NOW + PARKED_LOGIN_TTL_MS - 1));
});

test("clearing removes the file", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  clearParkedLogin();
  assert.equal(existsSync(pendingLoginFile()), false);
  assert.equal(readParkedLogin("poll-1", NOW), null);
});

test("clearing when nothing is parked is a no-op, not a throw", () => {
  assert.doesNotThrow(() => clearParkedLogin());
});

test("a corrupt park file is ignored rather than throwing", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  writeFileSync(pendingLoginFile(), "{not json");
  assert.equal(readParkedLogin("poll-1", NOW), null);
});

test("a park with no token is refused", () => {
  writeFileSync(pendingLoginFile(), JSON.stringify({ poll_id: "poll-1", token: "", account: ACCOUNT, at: NOW }));
  assert.equal(readParkedLogin("poll-1", NOW), null);
});

test("the parked file holds a bearer token, so it is written 0600", () => {
  parkLogin("poll-1", "sess-tok", ACCOUNT, NOW);
  const mode = statSync(pendingLoginFile()).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test("re-parking replaces the previous park", () => {
  parkLogin("poll-1", "old-tok", ACCOUNT, NOW);
  parkLogin("poll-2", "new-tok", ACCOUNT, NOW);
  assert.equal(readParkedLogin("poll-1", NOW), null);
  assert.equal(readParkedLogin<typeof ACCOUNT>("poll-2", NOW)?.token, "new-tok");
});
