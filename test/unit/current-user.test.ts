import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveIdentity,
  currentUser,
  setCurrentUser,
} from "../../src/current-user.ts";
import { usersDir, userDir, identityFile } from "../../src/paths.ts";

// current-user.ts resolves identities purely off the on-disk users/ tree (no
// crypto, no network). We point MESSENGER_HOME at a temp dir per test and seed
// identity dirs by hand, then assert the selector → directory resolution.
let prevHome: string | undefined;
let prevUser: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.MESSENGER_HOME;
  prevUser = process.env.MESSENGER_USER;
  delete process.env.MESSENGER_USER; // start clean; tests opt in explicitly
  home = mkdtempSync(join(tmpdir(), "clim-curuser-"));
  process.env.MESSENGER_HOME = home;
  mkdirSync(usersDir(), { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MESSENGER_HOME;
  else process.env.MESSENGER_HOME = prevHome;
  if (prevUser === undefined) delete process.env.MESSENGER_USER;
  else process.env.MESSENGER_USER = prevUser;
  rmSync(home, { recursive: true, force: true });
});

// Seed an identity directory keyed by its handle (the on-disk dir name), with an
// identity.json carrying the given metadata.
function seed(handle: string, meta: { handle?: string; name?: string; signPub?: string } = {}) {
  mkdirSync(userDir(handle), { recursive: true });
  writeFileSync(identityFile(handle), JSON.stringify({ handle, ...meta }));
}

// --- resolveIdentity (selector → directory) ---

test("resolveIdentity matches a literal directory name (the handle)", () => {
  seed("dC0v6m", { name: "Sam" });
  assert.equal(resolveIdentity("dC0v6m"), "dC0v6m");
});

test("resolveIdentity matches a display name case-insensitively", () => {
  seed("dC0v6m", { name: "Sam" });
  assert.equal(resolveIdentity("sam"), "dC0v6m");
  assert.equal(resolveIdentity("SAM"), "dC0v6m");
});

test("resolveIdentity matches on signPub", () => {
  seed("dC0v6m", { name: "Sam", signPub: "deadbeef" });
  assert.equal(resolveIdentity("deadbeef"), "dC0v6m");
});

test("resolveIdentity returns null when nothing matches", () => {
  seed("dC0v6m", { name: "Sam" });
  assert.equal(resolveIdentity("nobody"), null);
});

test("resolveIdentity ignores directories without an identity.json", () => {
  mkdirSync(userDir("empty"), { recursive: true }); // dir but no identity file
  assert.equal(resolveIdentity("empty"), null);
});

// --- currentUser (priority: env > pointer > sole identity) ---

test("currentUser honours MESSENGER_USER over the pointer", () => {
  seed("dC0v6m", { name: "Sam" });
  seed("F7wzEg", { name: "Niels" });
  setCurrentUser("dC0v6m");
  process.env.MESSENGER_USER = "Niels";
  assert.equal(currentUser(), "F7wzEg");
});

test("currentUser returns the raw selector when the env override is unresolved", () => {
  // Unresolved override still wins — it boots a (no-)account for that selector
  // rather than silently falling back to another identity.
  seed("dC0v6m", { name: "Sam" });
  process.env.MESSENGER_USER = "ghost";
  assert.equal(currentUser(), "ghost");
});

test("currentUser falls back to the .current pointer", () => {
  seed("dC0v6m", { name: "Sam" });
  seed("F7wzEg", { name: "Niels" });
  setCurrentUser("F7wzEg");
  assert.equal(currentUser(), "F7wzEg");
});

test("currentUser resolves a pointer that holds a display name", () => {
  seed("dC0v6m", { name: "Sam" });
  seed("F7wzEg", { name: "Niels" });
  setCurrentUser("Niels");
  assert.equal(currentUser(), "F7wzEg");
});

test("currentUser zero-configs to the sole identity when no env/pointer", () => {
  seed("dC0v6m", { name: "Sam" });
  assert.equal(currentUser(), "dC0v6m");
});

test("currentUser is null with multiple identities and no selector", () => {
  seed("dC0v6m", { name: "Sam" });
  seed("F7wzEg", { name: "Niels" });
  assert.equal(currentUser(), null);
});

test("currentUser is null when there are no identities at all", () => {
  assert.equal(currentUser(), null);
});

// --- setCurrentUser round-trip ---

test("setCurrentUser persists the device default for currentUser to read", () => {
  seed("dC0v6m", { name: "Sam" });
  seed("F7wzEg", { name: "Niels" });
  setCurrentUser("dC0v6m");
  assert.equal(currentUser(), "dC0v6m");
});
