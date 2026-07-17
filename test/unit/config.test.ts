import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveMailboxUrl, DEFAULT_MAILBOX_URL } from "../../src/config.ts";

let prev: string | undefined;

beforeEach(() => {
  prev = process.env.MESSENGER_MAILBOX_URL;
});

afterEach(() => {
  if (prev === undefined) delete process.env.MESSENGER_MAILBOX_URL;
  else process.env.MESSENGER_MAILBOX_URL = prev;
});

test("resolveMailboxUrl falls back to the hosted default when unset", () => {
  delete process.env.MESSENGER_MAILBOX_URL;
  assert.equal(resolveMailboxUrl(), DEFAULT_MAILBOX_URL);
});

test("resolveMailboxUrl returns the env override when set", () => {
  process.env.MESSENGER_MAILBOX_URL = "http://localhost:8787";
  assert.equal(resolveMailboxUrl(), "http://localhost:8787");
});

test("resolveMailboxUrl trims surrounding whitespace", () => {
  process.env.MESSENGER_MAILBOX_URL = "  http://localhost:8787  ";
  assert.equal(resolveMailboxUrl(), "http://localhost:8787");
});

test("resolveMailboxUrl treats a blank override as unset", () => {
  process.env.MESSENGER_MAILBOX_URL = "   ";
  assert.equal(resolveMailboxUrl(), DEFAULT_MAILBOX_URL);
});

test("DEFAULT_MAILBOX_URL is the hosted worker", () => {
  assert.equal(DEFAULT_MAILBOX_URL, "https://mailbox.cli-chat.dev");
});
