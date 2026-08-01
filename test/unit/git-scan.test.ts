// The git-history onboarding scan (git-scan.ts): builds real throwaway repos
// and checks the cleaning rules — bots, noreply/dead hosts, the user's own
// identities, already-saved people — plus same-name merging, the multi-repo
// (projects-folder) case, and the no_repo failure.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGitContacts, findRepos } from "../../src/git-scan.ts";

let root: string;

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

// One empty commit by `name <email>` at (roughly) `daysAgo`.
function commit(repo: string, name: string, email: string, daysAgo = 0): void {
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  execFileSync(
    "git",
    ["-C", repo, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--allow-empty", "-m", "x"],
    { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
  );
}

function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Me Myself");
  git(dir, "config", "user.email", "me@example.com");
  return dir;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "clim-gitscan-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("scanGitContacts", () => {
  test("cleans bots, noreply, own identities and saved people; merges same-name addresses", async () => {
    const repo = makeRepo(join(root, "app"));
    commit(repo, "Me Myself", "me@example.com", 5); // own (repo config)
    commit(repo, "Me Myself", "me@old-address.com", 40); // own (same name)
    commit(repo, "dependabot[bot]", "dependabot@github.com", 3); // bot
    commit(repo, "Nina", "nina@users.noreply.github.com", 2); // unreachable
    commit(repo, "Ole", "ole@mac.lan", 2); // dead host
    commit(repo, "Kim", "kim@example.com", 90); // already saved
    commit(repo, "Nina", "nina@corp.example", 30); // real — older address
    commit(repo, "Nina", "nina@new.example", 1); // real — newest address wins
    commit(repo, "Per", "per@example.com", 10); // real

    const r = await scanGitContacts({
      cwd: repo,
      savedEmails: new Set(["kim@example.com"]),
      ownNames: ["Me Myself"],
    });
    assert.ok(r.ok);
    const names = r.candidates.map((c) => c.name).sort();
    assert.deepEqual(names, ["Nina", "Per"]);
    const nina = r.candidates.find((c) => c.name === "Nina")!;
    assert.equal(nina.email, "nina@new.example"); // most recent reachable address
    assert.equal(nina.commits, 2); // corp + new merged (the noreply one was dropped)
    assert.equal(r.candidates[0]!.name, "Nina"); // sorted by most recent activity
    assert.equal(r.skipped.bots, 1);
    assert.equal(r.skipped.saved, 1);
    assert.equal(r.skipped.unreachable, 2);
    assert.ok(r.skipped.own >= 2);
  });

  test("the since window drops old contributors", async () => {
    const repo = makeRepo(join(root, "old"));
    commit(repo, "Ancient", "ancient@example.com", 900);
    commit(repo, "Recent", "recent@example.com", 5);
    const r = await scanGitContacts({ cwd: repo });
    assert.ok(r.ok);
    assert.deepEqual(r.candidates.map((c) => c.name), ["Recent"]);
    assert.equal(r.since, "12 months ago");
    const wide = await scanGitContacts({ cwd: repo, since: "5 years ago" });
    assert.ok(wide.ok);
    assert.deepEqual(wide.candidates.map((c) => c.name).sort(), ["Ancient", "Recent"]);
  });

  test("a projects folder scans every repo one level down and unions the roster", async () => {
    const folder = join(root, "projects");
    const a = makeRepo(join(folder, "alpha"));
    const b = makeRepo(join(folder, "beta"));
    commit(a, "Gitte", "gitte@example.com", 4);
    commit(b, "Gitte", "gitte@example.com", 2);
    commit(b, "Hans", "hans@example.com", 1);
    const r = await scanGitContacts({ cwd: folder });
    assert.ok(r.ok);
    assert.deepEqual(r.repos.sort(), ["alpha", "beta"]);
    const gitte = r.candidates.find((c) => c.name === "Gitte")!;
    assert.deepEqual(gitte.repos.sort(), ["alpha", "beta"]);
    assert.equal(gitte.commits, 2);
  });

  test("no repo in reach → no_repo; findRepos matches", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    assert.deepEqual(findRepos(empty), []);
    const r = await scanGitContacts({ cwd: empty });
    assert.equal(r.ok === false && r.reason, "no_repo");
  });
});
