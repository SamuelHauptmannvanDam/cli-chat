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
    assert.deepEqual(loadSettings(path), { tagMode: DEFAULT_TAG_MODE });
  });
});

test("default tag mode is auto", () => {
  assert.equal(DEFAULT_TAG_MODE, "auto");
});

test("saveSettings then loadSettings round-trips the mode", () => {
  withTmp((path) => {
    saveSettings(path, { tagMode: "off" });
    assert.deepEqual(loadSettings(path), { tagMode: "off" });
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
