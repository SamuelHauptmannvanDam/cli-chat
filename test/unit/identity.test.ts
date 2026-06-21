import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity } from "../../src/identity.ts";

// Write `content` to a temp identity.json, run `fn` with its path, always clean up.
function withIdentityFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "clim-identity-"));
  const path = join(dir, "identity.json");
  writeFileSync(path, content);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FULL = {
  boxPub: "bp",
  boxSec: "bs",
  signPub: "sp",
  signSec: "ss",
};

test("loadIdentity returns the parsed identity when all keys are present", () => {
  withIdentityFile(JSON.stringify({ ...FULL, name: "Sam", handle: "dC0v6m" }), (p) => {
    const id = loadIdentity(p);
    assert.equal(id.signPub, "sp");
    assert.equal((id as any).name, "Sam"); // extra fields pass through untouched
  });
});

for (const missing of ["boxPub", "boxSec", "signPub", "signSec"] as const) {
  test(`loadIdentity throws when ${missing} is absent`, () => {
    const { [missing]: _drop, ...rest } = FULL;
    withIdentityFile(JSON.stringify(rest), (p) => {
      assert.throws(() => loadIdentity(p), new RegExp(`missing ${missing}`));
    });
  });

  test(`loadIdentity throws when ${missing} is empty`, () => {
    withIdentityFile(JSON.stringify({ ...FULL, [missing]: "" }), (p) => {
      assert.throws(() => loadIdentity(p), new RegExp(`missing ${missing}`));
    });
  });
}

test("loadIdentity reports the path in the error", () => {
  withIdentityFile(JSON.stringify({ ...FULL, signSec: "" }), (p) => {
    assert.throws(() => loadIdentity(p), new RegExp(p.replace(/[.\\/]/g, "\\$&")));
  });
});

test("loadIdentity throws on invalid JSON", () => {
  withIdentityFile("{ not json", (p) => {
    assert.throws(() => loadIdentity(p));
  });
});

test("loadIdentity throws when the file does not exist", () => {
  assert.throws(() => loadIdentity(join(tmpdir(), "definitely-missing-xyz", "identity.json")));
});
