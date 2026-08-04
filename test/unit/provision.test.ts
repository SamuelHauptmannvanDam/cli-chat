import { test } from "node:test";
import assert from "node:assert/strict";
import { claimHandle } from "../../src/provision.ts";
import { HANDLE_LEN } from "../../src/core/key-code.ts";
import type { MailboxClient } from "../../src/core/mailbox-client.ts";

// A client whose registerHandle returns the queued verdicts in order, recording
// every handle it was asked to claim. Only registerHandle is exercised by
// claimHandle, so the other methods throw if anything unexpectedly calls them.
function fakeClient(verdicts: Array<"ok" | "taken">): {
  client: MailboxClient;
  asked: string[];
} {
  const asked: string[] = [];
  let i = 0;
  const client = {
    async registerHandle(handle: string) {
      asked.push(handle);
      const v = verdicts[i++];
      if (!v) throw new Error("registerHandle called more times than queued");
      return v;
    },
  } as unknown as MailboxClient;
  return { client, asked };
}

test("claimHandle returns the first handle the registry accepts", async () => {
  const { client, asked } = fakeClient(["ok"]);
  const handle = await claimHandle(client);
  assert.equal(asked.length, 1);
  assert.equal(handle, asked[0]);
});

test("claimHandle retries past collisions until one is free", async () => {
  const { client, asked } = fakeClient(["taken", "taken", "ok"]);
  const handle = await claimHandle(client);
  assert.equal(asked.length, 3);
  assert.equal(handle, asked[2]);
});

test("claimHandle generates a fresh candidate per attempt", async () => {
  // With real randomness the colliding candidates are overwhelmingly distinct;
  // assert the loop re-rolls rather than re-submitting the same string.
  const { client, asked } = fakeClient(["taken", "taken", "ok"]);
  await claimHandle(client);
  assert.equal(new Set(asked).size, asked.length);
});

test("claimHandle throws after exhausting all attempts", async () => {
  const { client, asked } = fakeClient(["taken", "taken", "taken"]);
  await assert.rejects(() => claimHandle(client, 3), /couldn't find a free handle/);
  assert.equal(asked.length, 3);
});

test("claimHandle honours a custom attempt budget", async () => {
  const { client, asked } = fakeClient(["taken"]);
  await assert.rejects(() => claimHandle(client, 1));
  assert.equal(asked.length, 1);
});

test("claimHandle yields a well-formed 6-char handle", async () => {
  const { client } = fakeClient(["ok"]);
  const handle = await claimHandle(client);
  assert.equal(handle.length, HANDLE_LEN);
});
