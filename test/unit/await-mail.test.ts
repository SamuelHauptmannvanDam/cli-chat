import test from "node:test";
import assert from "node:assert/strict";
import { pickUnsurfaced } from "../../src/await-mail.ts";
import type { InboxMessage } from "../../src/core-net.ts";

const msg = (id: string): InboxMessage => ({
  id,
  from: "Sam",
  body: `hi ${id}`,
  at: 1,
  in_reply_to: null,
});

test("pickUnsurfaced returns only messages not yet acked", () => {
  const out = pickUnsurfaced([msg("a"), msg("b"), msg("c")], new Set(["b"]));
  assert.deepEqual(
    out.map((m) => m.id),
    ["a", "c"],
  );
  assert.equal(out[0]!.from, "Sam");
  assert.equal(out[0]!.body, "hi a");
});

test("pickUnsurfaced is empty when every message is already acked", () => {
  assert.equal(pickUnsurfaced([msg("a"), msg("b")], new Set(["a", "b"])).length, 0);
});

test("pickUnsurfaced returns the whole batch when nothing is acked", () => {
  assert.equal(pickUnsurfaced([msg("a"), msg("b")], new Set()).length, 2);
});
