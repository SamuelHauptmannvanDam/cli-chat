import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettings,
  saveSettings,
  DEFAULT_TAG_MODE,
  type Settings,
} from "../../src/settings.ts";

function withTmp(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "clim-settings-"));
  try {
    fn(join(dir, "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSettings returns the default mode when the file is missing", () => {
  withTmp((path) => {
    assert.deepEqual(loadSettings(path), {
      tagMode: DEFAULT_TAG_MODE,
      requestsOnly: false,
      feedbackSeeded: false,
      notify: true,
      emailNotify: true,
    });
  });
});

test("default tag mode is auto", () => {
  assert.equal(DEFAULT_TAG_MODE, "auto");
});

test("saveSettings then loadSettings round-trips the mode", () => {
  withTmp((path) => {
    saveSettings(path, { tagMode: "off", requestsOnly: false, feedbackSeeded: true, notify: false, emailNotify: false });
    assert.deepEqual(loadSettings(path), { tagMode: "off", requestsOnly: false, feedbackSeeded: true, notify: false, emailNotify: false });
  });
});

test("loadSettings falls back to default for a corrupt file", () => {
  withTmp((path) => {
    writeFileSync(path, "{ not json");
    assert.equal(loadSettings(path).tagMode, DEFAULT_TAG_MODE);
  });
});

test("loadSettings ignores an unrecognised mode value", () => {
  withTmp((path) => {
    writeFileSync(path, JSON.stringify({ tagMode: "bogus" } as unknown as Settings));
    assert.equal(loadSettings(path).tagMode, DEFAULT_TAG_MODE);
  });
});

test("notify defaults ON for a pre-0.22 settings file without the field", () => {
  withTmp((path) => {
    writeFileSync(path, JSON.stringify({ tagMode: "auto", requestsOnly: false, feedbackSeeded: true }));
    assert.equal(loadSettings(path).notify, true);
  });
});

test("notify: only an explicit false turns it off", () => {
  withTmp((path) => {
    writeFileSync(path, JSON.stringify({ notify: false }));
    assert.equal(loadSettings(path).notify, false);
    writeFileSync(path, JSON.stringify({ notify: "no" }));
    assert.equal(loadSettings(path).notify, true);
  });
});

test("emailNotify defaults ON for a pre-0.23 settings file without the field", () => {
  withTmp((path) => {
    writeFileSync(path, JSON.stringify({ tagMode: "auto", requestsOnly: false, notify: true }));
    assert.equal(loadSettings(path).emailNotify, true);
  });
});

test("emailNotify: only an explicit false turns it off", () => {
  withTmp((path) => {
    writeFileSync(path, JSON.stringify({ emailNotify: false }));
    assert.equal(loadSettings(path).emailNotify, false);
    writeFileSync(path, JSON.stringify({ emailNotify: "no" }));
    assert.equal(loadSettings(path).emailNotify, true);
  });
});
