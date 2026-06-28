import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dataHome,
  usersDir,
  userDir,
  identityFile,
  contactsFile,
  inboxFile,
  pendingFile,
  pendingAckFile,
  chatHintFile,
} from "../../src/paths.ts";

// paths.ts reads MESSENGER_HOME fresh on every call, so each test can point it at
// its own temp dir. We save/restore the real env so tests don't leak into each
// other or into the rest of the suite.
let prevHome: string | undefined;
let home: string;

beforeEach(() => {
  prevHome = process.env.MESSENGER_HOME;
  home = mkdtempSync(join(tmpdir(), "clim-paths-"));
  process.env.MESSENGER_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MESSENGER_HOME;
  else process.env.MESSENGER_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

test("dataHome returns MESSENGER_HOME when set", () => {
  assert.equal(dataHome(), home);
});

test("dataHome trims surrounding whitespace from the env value", () => {
  process.env.MESSENGER_HOME = `  ${home}  `;
  assert.equal(dataHome(), home);
});

test("dataHome ignores a blank (whitespace-only) env value", () => {
  // A blank override must NOT be treated as a real home; it falls through to the
  // legacy/default resolution instead of returning "".
  process.env.MESSENGER_HOME = "   ";
  assert.notEqual(dataHome(), "");
  assert.notEqual(dataHome(), "   ");
});

test("dataHome is read fresh on each call", () => {
  const other = mkdtempSync(join(tmpdir(), "clim-paths-2-"));
  try {
    process.env.MESSENGER_HOME = other;
    assert.equal(dataHome(), other);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("usersDir is the users/ child of the data home", () => {
  assert.equal(usersDir(), join(home, "users"));
});

test("userDir nests the user under users/", () => {
  assert.equal(userDir("abc123"), join(home, "users", "abc123"));
});

test("per-user file paths all sit inside that user's dir", () => {
  const u = "abc123";
  const dir = join(home, "users", u);
  assert.equal(identityFile(u), join(dir, "identity.json"));
  assert.equal(contactsFile(u), join(dir, "contacts.json"));
  assert.equal(inboxFile(u), join(dir, "inbox.db"));
  assert.equal(pendingFile(u), join(dir, "pending.json"));
  assert.equal(pendingAckFile(u), join(dir, "pending-ack.json"));
  assert.equal(chatHintFile(u), join(dir, "chat-hint.json"));
});

test("identity and pending files are distinct names", () => {
  const u = "abc123";
  const names = new Set([
    identityFile(u),
    contactsFile(u),
    inboxFile(u),
    pendingFile(u),
    pendingAckFile(u),
    chatHintFile(u),
  ]);
  assert.equal(names.size, 6);
});
