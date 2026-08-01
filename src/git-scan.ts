// Git-history onboarding (EMAIL-SEND.md "Silent save"): find the people the
// user actually works with — candidates for silent save-by-email — by reading
// the commit log of the repo they're standing in (or every repo one level
// under the folder they're standing in). Runs in the MCP SERVER process, so it
// works from ANY client: the agent never needs shell access, git runs here.
// Read-only (git log / git config), never writes to a repo, never touches the
// network — cleaning and aggregation are pure local bookkeeping.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface BlameCandidate {
  name: string; // committer's name as git records it (untrusted display text)
  email: string; // their most recently used reachable address
  commits: number;
  last: string; // YYYY-MM-DD of their most recent commit in range
  lastAt: number; // same, epoch ms (sort key)
  repos: string[]; // repo dir names they appeared in
}

export interface BlameScanOk {
  ok: true;
  repos: string[]; // repo dir names scanned
  since: string;
  candidates: BlameCandidate[];
  // Unique authors dropped, by why — so the agent can say what was skipped.
  skipped: { bots: number; unreachable: number; own: number; saved: number };
}

export type BlameScanResult =
  | BlameScanOk
  // no_repo: neither cwd nor its immediate children are git repos.
  // no_git: repos exist but git itself isn't runnable on this machine.
  | { ok: false; reason: "no_repo" | "no_git" };

const BOT_RE = /\[bot\]|dependabot|renovate|github-actions|greenkeeper|snyk-bot/i;
const NOREPLY_RE = /no-?reply/i;
const DEAD_HOST_RE = /\.(lan|local|localdomain|internal|invalid|test)$|^localhost$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function git(dir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
      resolve(err ? null : out),
    );
  });
}

// The repo(s) in reach: cwd itself when it's one, else its immediate child
// dirs that are (the "standing in my projects folder" case). One level only.
export function findRepos(cwd: string): string[] {
  if (existsSync(join(cwd, ".git"))) return [cwd];
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(cwd, d.name, ".git")))
      .map((d) => join(cwd, d.name));
  } catch {
    return [];
  }
}

export async function scanGitContacts(opts: {
  cwd: string;
  since?: string; // any git-parsable date phrase; default "12 months ago"
  savedEmails?: Set<string>; // lower-cased addresses already in the contact book
  ownEmails?: string[]; // the user's own addresses (account email etc.)
  ownNames?: string[]; // the user's own name(s) — catches their other identities
}): Promise<BlameScanResult> {
  const repos = findRepos(opts.cwd);
  if (!repos.length) return { ok: false, reason: "no_repo" };
  const since = opts.since?.trim() || "12 months ago";
  const saved = opts.savedEmails ?? new Set<string>();
  const own = new Set((opts.ownEmails ?? []).map((e) => e.toLowerCase()));
  const ownNames = new Set((opts.ownNames ?? []).filter(Boolean).map((n) => n!.trim().toLowerCase()));

  interface Seen {
    name: string;
    email: string;
    commits: number;
    lastAt: number;
    repos: Set<string>;
  }
  const byEmail = new Map<string, Seen>();
  let anyGit = false;

  for (const repo of repos) {
    // The repo's configured committer = the user themselves, whatever address
    // they commit under here (work alias, old email) — never a candidate.
    const cfg = (await git(repo, ["config", "user.email"]))?.trim().toLowerCase();
    if (cfg) own.add(cfg);
    // %aE/%aN honour .mailmap, so a mapped identity arrives pre-merged.
    const out = await git(repo, ["log", "--all", `--since=${since}`, "--format=%aE%x09%aN%x09%at"]);
    if (out == null) continue;
    anyGit = true;
    const label = basename(repo);
    for (const line of out.split("\n")) {
      const [rawEmail, name, at] = line.split("\t");
      if (!rawEmail || !name || !at) continue;
      const email = rawEmail.trim().toLowerCase();
      const t = Number(at) * 1000;
      const cur = byEmail.get(email);
      if (cur) {
        cur.commits++;
        cur.repos.add(label);
        if (t > cur.lastAt) {
          cur.lastAt = t;
          cur.name = name.trim(); // keep the most recent spelling of their name
        }
      } else {
        byEmail.set(email, { name: name.trim(), email, commits: 1, lastAt: t, repos: new Set([label]) });
      }
    }
  }
  if (!anyGit) return { ok: false, reason: "no_git" };

  // Classify unique authors; count the drops so the agent can name them.
  const skipped = { bots: 0, unreachable: 0, own: 0, saved: 0 };
  const keep: Seen[] = [];
  for (const a of byEmail.values()) {
    const host = a.email.split("@")[1] ?? "";
    if (own.has(a.email) || ownNames.has(a.name.toLowerCase())) skipped.own++;
    else if (BOT_RE.test(a.name) || BOT_RE.test(a.email)) skipped.bots++;
    else if (NOREPLY_RE.test(a.email) || DEAD_HOST_RE.test(host) || !EMAIL_RE.test(a.email)) skipped.unreachable++;
    else if (saved.has(a.email)) skipped.saved++;
    else keep.push(a);
  }

  // One person often commits under several addresses; same (exact) name →
  // one candidate, reached at their most recently used address.
  const byName = new Map<string, Seen[]>();
  for (const a of keep) {
    const k = a.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), a]);
  }
  const candidates: BlameCandidate[] = [...byName.values()]
    .map((group) => {
      const primary = group.reduce((x, y) => (y.lastAt > x.lastAt ? y : x));
      const repoSet = new Set(group.flatMap((g) => [...g.repos]));
      return {
        name: primary.name,
        email: primary.email,
        commits: group.reduce((n, g) => n + g.commits, 0),
        last: new Date(primary.lastAt).toISOString().slice(0, 10),
        lastAt: primary.lastAt,
        repos: [...repoSet],
      };
    })
    .sort((x, y) => y.lastAt - x.lastAt);

  return { ok: true, repos: repos.map((r) => basename(r)), since, candidates, skipped };
}
