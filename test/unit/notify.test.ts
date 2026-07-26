import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeNotification, notifyEnabled } from "../../src/notify.ts";

test("one fresh message → sender title + body preview", () => {
  const n = composeNotification([{ from: "Niels", body: "Did the deploy go out?", held: false }]);
  assert.deepEqual(n, { title: "Niels", body: "Did the deploy go out?" });
});

test("preview collapses whitespace and caps at 120 chars", () => {
  const n = composeNotification([{ from: "Niels", body: "line one\n\nline two   spaced " + "x".repeat(200), held: false }]);
  assert.ok(n!.body.startsWith("line one line two spaced"));
  assert.equal(n!.body.length, 120);
});

test("a batch collapses to counts + deduped names, no bodies", () => {
  const n = composeNotification([
    { from: "Niels", body: "secret one", held: false },
    { from: "Niels", body: "secret two", held: false },
    { from: "Sam", body: "secret three", held: false },
  ]);
  assert.equal(n!.title, "cli-chat");
  assert.equal(n!.body, "3 new messages from Niels, Sam");
  assert.ok(!n!.body.includes("secret"));
});

test("held new-handle mail NEVER contributes a body, even alone", () => {
  const n = composeNotification([
    { from: "Sam (AbC123)", body: "sealed — must not leak", held: true },
    { from: "Sam (AbC123)", body: "sealed too", held: true },
  ]);
  assert.equal(n!.title, "cli-chat");
  assert.equal(n!.body, "2 held from new handle Sam (AbC123)");
  assert.ok(!n!.body.includes("sealed"));
});

test("one normal + held mixes to the summary form (no preview)", () => {
  const n = composeNotification([
    { from: "Niels", body: "the actual text", held: false },
    { from: "Sam (AbC123)", body: "sealed", held: true },
  ]);
  assert.equal(n!.title, "cli-chat");
  assert.equal(n!.body, "1 new message from Niels · 1 held from new handle Sam (AbC123)");
});

test("no items → null", () => {
  assert.equal(composeNotification([]), null);
});

test("notifyEnabled: settings default on, explicit off honoured, env wins both ways", () => {
  const dir = mkdtempSync(join(tmpdir(), "clim-notify-"));
  const path = join(dir, "settings.json");
  const env = process.env.MESSENGER_NOTIFY;
  try {
    delete process.env.MESSENGER_NOTIFY;
    assert.equal(notifyEnabled(path), true); // no file → default on
    writeFileSync(path, JSON.stringify({ notify: false }));
    assert.equal(notifyEnabled(path), false); // preference off
    process.env.MESSENGER_NOTIFY = "1";
    assert.equal(notifyEnabled(path), true); // env forces on over the preference
    writeFileSync(path, JSON.stringify({ notify: true }));
    process.env.MESSENGER_NOTIFY = "0";
    assert.equal(notifyEnabled(path), false); // env forces off over the preference
  } finally {
    if (env === undefined) delete process.env.MESSENGER_NOTIFY;
    else process.env.MESSENGER_NOTIFY = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
