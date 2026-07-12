// Orchestrates the online-account sync (AUTH-SYNC.md): the magic-link poll loop
// and the pull/push/merge of the vault. Kept out of server-net.ts so the logic is
// unit-testable without the MCP plumbing. Local-first: callers pull at session
// start and push when the dirty flag is set; reads never touch the network.

import type { AccountClient, PollResult } from "./account-client.ts";
import { assembleVault, applyVault, mergeVaults } from "./vault.ts";
import { decryptBlob, encryptBlob } from "./blob-crypto.ts";
import { setVaultVersion, clearVaultDirty } from "./session.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll until the emailed link is clicked, the login expires, or we hit the
// deadline (so a tool call can't hang forever — it returns "pending" and the
// caller resumes with the same poll id). `intervalMs`/`deadlineMs` are caller-set.
export async function pollUntilReady(
  client: AccountClient,
  pollId: string,
  intervalMs: number,
  deadlineMs: number,
  clock: () => number = () => Date.now(),
): Promise<PollResult> {
  const stop = clock() + deadlineMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await client.poll(pollId);
    if (r.status !== "pending") return r;
    if (clock() + intervalMs >= stop) return { status: "pending" };
    await sleep(intervalMs);
  }
}

export type SyncOutcome =
  | { action: "pulled"; version: number; handle: string }
  | { action: "merged"; version: number; handle: string }
  | { action: "pushed"; version: number }
  | { action: "noop"; version: number }
  | { action: "payment_required"; checkoutUrl: string | null }
  | { action: "unauthorized" };

// Reconcile this device's vault with the server's, given the bearer token, the
// device `user` (handle dir), its `signPub` (bound on first push), the last
// version this device saw, and whether local state changed since (`dirty`).
// `dataKey` seals blobs before they leave the device (blob-crypto.ts); when
// absent, blobs travel as before (legacy plaintext) so old sessions keep working.
export async function syncVault(
  client: AccountClient,
  token: string,
  user: string,
  signPub: string,
  knownVersion: number,
  dirty: boolean,
  dataKey?: string,
): Promise<SyncOutcome> {
  const pulled = await client.pullVault(token);
  if (pulled === "unauthorized") return { action: "unauthorized" };
  if (pulled === "payment_required") return { action: "payment_required", checkoutUrl: null };

  const serverVersion = pulled.version;
  const serverAhead = serverVersion > knownVersion && pulled.blob != null;
  // decryptBlob passes legacy plaintext blobs through untouched.
  const serverBlob = pulled.blob != null ? decryptBlob(pulled.blob, dataKey) : null;

  // Server is ahead and we have no local edits → adopt the server blob wholesale.
  if (serverAhead && !dirty) {
    const handle = applyVault(serverBlob!);
    setVaultVersion(user, serverVersion);
    return { action: "pulled", version: serverVersion, handle };
  }

  // Server is ahead AND we have local edits → merge, then push at server+1.
  if (serverAhead && dirty) {
    const merged = mergeVaults(assembleVault(user), serverBlob!);
    const handle = applyVault(merged);
    const res = await pushBlob(client, token, merged, serverVersion + 1, signPub, user, dataKey);
    if (res.action === "pushed") return { action: "merged", version: res.version, handle };
    return res;
  }

  // We're current with (or ahead of) the server. Push only if we have edits, or
  // if the server has nothing yet (first push from this account).
  if (dirty || pulled.blob == null) {
    const base = Math.max(serverVersion, knownVersion);
    return pushBlob(client, token, assembleVault(user), base + 1, signPub, user, dataKey);
  }

  // Nothing to do, but stay in step with the server's version number.
  if (serverVersion !== knownVersion) setVaultVersion(user, serverVersion);
  return { action: "noop", version: serverVersion };
}

// Push a blob (sealed when a data key is present), retrying once on a stale (409)
// conflict by merging the server's current row in and pushing again at its
// version+1. Clears the dirty flag on a successful push.
async function pushBlob(
  client: AccountClient,
  token: string,
  blob: string,
  version: number,
  signPub: string,
  user: string,
  dataKey?: string,
): Promise<SyncOutcome> {
  const seal = (plain: string) => (dataKey ? encryptBlob(plain, dataKey) : plain);
  let res = await client.pushVault(token, seal(blob), version, signPub);
  if (res.ok) {
    setVaultVersion(user, res.version);
    clearVaultDirty(user);
    return { action: "pushed", version: res.version };
  }
  if (res.reason === "payment_required")
    return { action: "payment_required", checkoutUrl: res.checkoutUrl };
  // Stale: someone else pushed between our pull and push. Merge and retry once.
  const merged = mergeVaults(blob, decryptBlob(res.current.blob, dataKey));
  applyVault(merged);
  const retry = await client.pushVault(token, seal(merged), res.current.version + 1, signPub);
  if (retry.ok) {
    setVaultVersion(user, retry.version);
    clearVaultDirty(user);
    return { action: "pushed", version: retry.version };
  }
  // Still stale or unpaid → report current version; caller can resync next start.
  return { action: "noop", version: res.current.version };
}
