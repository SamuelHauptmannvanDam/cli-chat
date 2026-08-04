// The self-introduction envelope that rides inside a sealed body: round-trips
// text + sender identity, and treats anything that isn't our envelope (legacy
// plain bodies, unrelated JSON) as plain text — full back-compat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { packBody, unpackBody } from "../../src/core-net.ts";
import type { Identity } from "../../src/core/crypto.ts";

const me = {
  boxPub: "box-pub-hex",
  boxSec: "",
  signPub: "sign-pub-hex",
  signSec: "",
  handle: "dC0v6m",
  name: "Sam",
} as Identity;

test("packBody → unpackBody round-trips text + name + handle + reply key", () => {
  const u = unpackBody(packBody(me, "hi there"));
  assert.equal(u.text, "hi there");
  assert.equal(u.name, "Sam");
  assert.equal(u.handle, "dC0v6m");
  assert.equal(u.boxPub, "box-pub-hex");
});

test("packBody always carries the reply key even with no name/handle set", () => {
  const anon = { boxPub: "bp", boxSec: "", signPub: "sp", signSec: "" } as Identity;
  const u = unpackBody(packBody(anon, "yo"));
  assert.equal(u.text, "yo");
  assert.equal(u.boxPub, "bp");
  assert.equal(u.name, undefined);
  assert.equal(u.handle, undefined);
});

test("unpackBody passes a legacy plain body straight through", () => {
  const u = unpackBody("just some old plaintext");
  assert.equal(u.text, "just some old plaintext");
  assert.equal(u.boxPub, undefined);
});

test("unpackBody treats unrelated JSON as plain text (not an envelope)", () => {
  const notOurs = JSON.stringify({ hello: "world" });
  assert.equal(unpackBody(notOurs).text, notOurs);
  // Any non-envelope string passes through untouched (e.g. a bracketed status line).
  const bracketed = "[some bracketed text — not our envelope]";
  assert.equal(unpackBody(bracketed).text, bracketed);
});

// ---- the group block (GROUPS: 0.24) — sender-controlled, so validated hard ----

const HEX64 = "a".repeat(64);
const HEX64B = "b".repeat(64);
const BOX = "A".repeat(44); // base64-ish, in the accepted length band

const goodGroup = {
  id: "g0123456789abcdef",
  name: "project-x",
  mid: "11111111-2222-3333-4444-555555555555",
  roster: [
    { name: "Alice", signPub: HEX64, boxPub: BOX },
    { name: "Bob", signPub: HEX64B, boxPub: BOX },
  ],
};

test("group block round-trips through pack/unpack", () => {
  const u = unpackBody(packBody(me, "hey", { group: { ...goodGroup, op: "create" } }));
  assert.equal(u.group?.id, goodGroup.id);
  assert.equal(u.group?.name, "project-x");
  assert.equal(u.group?.mid, goodGroup.mid);
  assert.equal(u.group?.op, "create");
  assert.equal(u.group?.roster.length, 2);
  assert.equal(u.group?.roster[0]?.signPub, HEX64);
});

test("a malformed group id or mid drops the whole block (message still lands)", () => {
  for (const bad of [
    { ...goodGroup, id: "not-a-group-id" },
    { ...goodGroup, id: HEX64 }, // a signPub is not a group id
    { ...goodGroup, mid: "short" },
    { ...goodGroup, mid: "x".repeat(200) },
  ]) {
    const u = unpackBody(JSON.stringify({ v: 1, text: "hi", boxPub: "bp", group: bad }));
    assert.equal(u.group, undefined);
    assert.equal(u.text, "hi");
  }
});

test("hostile roster entries are dropped, valid ones kept, size capped", () => {
  const raw = {
    ...goodGroup,
    roster: [
      { name: "ok", signPub: HEX64, boxPub: BOX },
      { name: "bad-key", signPub: "zz", boxPub: BOX }, // dropped
      { name: "bad-box", signPub: HEX64B, boxPub: "!!" }, // dropped
      "not-an-object", // dropped
    ],
  };
  const u = unpackBody(JSON.stringify({ v: 1, text: "hi", boxPub: "bp", group: raw }));
  assert.equal(u.group?.roster.length, 1);
  assert.equal(u.group?.roster[0]?.signPub, HEX64);

  const oversized = {
    ...goodGroup,
    roster: Array.from({ length: 500 }, (_, i) => ({
      signPub: i.toString(16).padStart(64, "0"),
      boxPub: BOX,
    })),
  };
  const u2 = unpackBody(JSON.stringify({ v: 1, text: "hi", boxPub: "bp", group: oversized }));
  assert.ok((u2.group?.roster.length ?? 0) <= 64);
});

test("an invented op value is ignored, control chars are stripped from the name", () => {
  const raw = { ...goodGroup, op: "obey-me", name: "pro\x00ject\nx" };
  const u = unpackBody(JSON.stringify({ v: 1, text: "hi", boxPub: "bp", group: raw }));
  assert.equal(u.group?.op, undefined);
  assert.ok(!/[\x00-\x1f]/.test(u.group?.name ?? ""));
});
