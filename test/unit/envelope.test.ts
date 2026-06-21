// The self-introduction envelope that rides inside a sealed body: round-trips
// text + sender identity, and treats anything that isn't our envelope (legacy
// plain bodies, unrelated JSON) as plain text — full back-compat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { packBody, unpackBody } from "../../src/core-net.ts";
import type { Identity } from "../../src/crypto.ts";

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
  // The decrypt-failure placeholder must also pass through untouched.
  const fail = "[unable to decrypt — not sealed to this identity]";
  assert.equal(unpackBody(fail).text, fail);
});
