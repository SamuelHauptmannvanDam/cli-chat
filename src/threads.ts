// The file half of tiered history (HISTORY.md), plus the notes half of the
// messenger's memory (AUTO-CHAT.md).
//
// THREADS — one living page per contact under <context>/threads/:
//
//   # Niels
//   ## Digest
//   (agent-curated summary — ongoing topics, decisions, open loops)
//   ## Recent
//   - 2026-07-09T14:02 ← Niels: can you send the env vars?
//   - 2026-07-09T14:05 → me: REDIS_URL and API_KEY, see .env.example
//
// The Recent tail is maintained MECHANICALLY here (append on drain/send, trimmed
// to a bounded window); the Digest section belongs to the agent and is preserved
// verbatim on every mechanical rewrite. The file is a projection of the db —
// `rebuildThreads` regenerates every tail from the recall store at any time (and
// runs once on upgrade so existing cached mail appears as files day one).
//
// NOTES — small topical md files under <context>/notes/ ("remember X", facts
// learned from mail, answered escalations, pending questions). Appended via
// rememberNote, read wholesale via recallNotes — both tiny by design; curation
// beyond append (rewriting stale facts) is the agent editing the file.
//
// Everything is written with the secret-file posture (0600/0700): these are
// decrypted conversations and distilled private facts.

import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { secureDir, writeSecretAtomic } from "./secure-fs.ts";
import { historyFor, type Mailbox } from "./db.ts";
import type { ContactBook } from "./contacts.ts";
import { senderLabel, contactByKey } from "./contacts.ts";

export const TAIL_MAX_ENTRIES = 30;
export const TAIL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // ~14 days

const RECENT_MARKER = "## Recent";
const DIGEST_MARKER = "## Digest";
const DIGEST_PLACEHOLDER =
  "_(agent-curated: who they are, ongoing topics, decisions, open loops — update\n" +
  "this section when handling this thread's mail; the tail below is mechanical)_";

export interface ThreadEntry {
  direction: "in" | "out";
  who: string; // label for the writer ("me" for out, the contact's nick for in)
  body: string;
  at: number; // epoch ms
  assistant?: boolean; // written by an agent, not the human (answered_by)
}

// A thread file is keyed by the contact's signPub (stable across renames); the
// nickname rides in the filename for human browsing and is re-slugged on rename.
//   <slug-of-nick>--<key8>.md
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "contact";
}

function keyTag(signPub: string): string {
  return signPub.slice(0, 8);
}

// Locate the existing file for a contact key (whatever nickname it was written
// under), or null.
function findThreadFile(dir: string, signPub: string): string | null {
  const suffix = `--${keyTag(signPub)}.md`;
  try {
    for (const f of readdirSync(dir)) if (f.endsWith(suffix)) return join(dir, f);
  } catch {
    /* dir missing — no files yet */
  }
  return null;
}

export function threadFilePath(dir: string, name: string, signPub: string): string {
  return join(dir, `${slug(name)}--${keyTag(signPub)}.md`);
}

// Render one tail entry. The timestamp prefix is what the parser keys on, so
// multi-line bodies indent their continuation lines (a body line that itself
// starts with "- " can never be mistaken for an entry — it won't carry the
// timestamp shape).
function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16); // 2026-07-09T14:02
}

function renderEntry(e: ThreadEntry): string {
  const arrow = e.direction === "in" ? "←" : "→";
  const who = e.assistant ? `${e.who} (assistant)` : e.who;
  const [first = "", ...rest] = e.body.split("\n");
  const cont = rest.map((l) => `  ${l}`);
  return [`- ${stamp(e.at)} ${arrow} ${who}: ${first}`, ...cont].join("\n");
}

const ENTRY_RE = /^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}) /;

// Split a Recent section into entry blocks (entry line + its continuations).
// ONLY a timestamped entry line starts a new block — everything else (indented
// continuations, even blank lines inside a multi-paragraph body) stays attached
// to the current one, so reparsing never truncates a stored body.
function parseTail(recent: string): { at: number; block: string }[] {
  const out: { at: number; block: string }[] = [];
  let cur: string[] | null = null;
  let curAt = 0;
  const flush = () => {
    while (cur && cur.length && cur[cur.length - 1]!.trim() === "") cur.pop(); // tidy trailing blanks
    if (cur && cur.length) out.push({ at: curAt, block: cur.join("\n") });
    cur = null;
  };
  for (const line of recent.split("\n")) {
    const m = ENTRY_RE.exec(line);
    if (m) {
      flush();
      cur = [line];
      curAt = Date.parse(m[1]! + ":00Z");
    } else if (cur) {
      cur.push(line);
    }
    /* else: preamble noise before the first entry — drop */
  }
  flush();
  return out;
}

function renderFile(title: string, digest: string, blocks: string[]): string {
  return `# ${title}\n\n${DIGEST_MARKER}\n\n${digest.trim() || DIGEST_PLACEHOLDER}\n\n${RECENT_MARKER}\n\n${blocks.join("\n")}\n`;
}

// Pull the digest section (between "## Digest" and "## Recent") out of an
// existing file so mechanical rewrites never lose the agent's curation.
function splitFile(content: string): { digest: string; recent: string } {
  const rIdx = content.indexOf(RECENT_MARKER);
  const dIdx = content.indexOf(DIGEST_MARKER);
  if (rIdx < 0) return { digest: "", recent: "" };
  const digest =
    dIdx >= 0 && dIdx < rIdx ? content.slice(dIdx + DIGEST_MARKER.length, rIdx).trim() : "";
  return { digest, recent: content.slice(rIdx + RECENT_MARKER.length) };
}

function trim(blocks: { at: number; block: string }[], now: number): string[] {
  const cutoff = now - TAIL_MAX_AGE_MS;
  const kept = blocks.filter((b) => !(b.at > 0 && b.at < cutoff));
  return kept.slice(Math.max(0, kept.length - TAIL_MAX_ENTRIES)).map((b) => b.block);
}

// Append one message to a contact's thread tail (creating the file, renaming it
// if the nickname changed) and trim the window. Best-effort by contract: history
// files must never break a send or a drain, so callers wrap in try/catch — but
// keep this internally non-throwing for the common cases anyway.
export function appendToThread(
  dir: string,
  contact: { name: string; signPub: string },
  entry: ThreadEntry,
  now: number,
): void {
  secureDir(dir);
  const target = threadFilePath(dir, contact.name, contact.signPub);
  let path = findThreadFile(dir, contact.signPub);
  if (path && path !== target) {
    // Renamed contact: move the page so the filename tracks the current nick.
    try {
      renameSync(path, target);
      path = target;
    } catch {
      /* keep writing under the old name rather than lose the entry */
    }
  }
  if (!path) path = target;
  let digest = "";
  let blocks: { at: number; block: string }[] = [];
  if (existsSync(path)) {
    try {
      const prev = splitFile(readFileSync(path, "utf8"));
      digest = prev.digest;
      blocks = parseTail(prev.recent);
    } catch {
      /* unreadable — regenerate from scratch */
    }
  }
  blocks.push({ at: entry.at, block: renderEntry(entry) });
  blocks.sort((a, b) => a.at - b.at);
  writeSecretAtomic(path, renderFile(contact.name, digest, trim(blocks, now)));
}

// Append one dated fact to a contact's Digest section — the memory_add `about`
// route. The digest stays agent-curated prose otherwise; routed facts use the
// same dated one-per-line shape as memory notes so staleness stays checkable
// and the agent can prune lines surgically. First routed fact replaces the
// placeholder. Returns the file written.
export function appendDigestFact(
  dir: string,
  contact: { name: string; signPub: string },
  text: string,
  now: number,
  source?: string,
): string {
  secureDir(dir);
  const target = threadFilePath(dir, contact.name, contact.signPub);
  let path = findThreadFile(dir, contact.signPub);
  if (path && path !== target) {
    try {
      renameSync(path, target);
      path = target;
    } catch {
      /* keep writing under the old name rather than lose the fact */
    }
  }
  if (!path) path = target;
  let digest = "";
  let blocks: { at: number; block: string }[] = [];
  if (existsSync(path)) {
    try {
      const prev = splitFile(readFileSync(path, "utf8"));
      digest = prev.digest;
      blocks = parseTail(prev.recent);
    } catch {
      /* unreadable — regenerate around the new fact */
    }
  }
  if (digest === DIGEST_PLACEHOLDER) digest = "";
  const src = source ? ` (${source.replace(/[()\n]/g, " ").trim()})` : "";
  const line = `- ${new Date(now).toISOString().slice(0, 10)}${src}: ${text.replace(/\s*\n\s*/g, " ").trim()}`;
  writeSecretAtomic(
    path,
    renderFile(contact.name, digest ? `${digest}\n${line}` : line, trim(blocks, now)),
  );
  return path;
}

// Is this tag load-bearing for disclosure — i.e. does any memory note carry it
// as an `@<tag>` audience? Powers the never-silent-when-load-bearing rule:
// auto-applying such a tag widens what that contact may hear via memory_recall,
// so the apply is always announced.
export function audienceInUse(notesDirPath: string, tag: string): boolean {
  const t = tag.trim().toLowerCase();
  if (!t) return false;
  let files: string[] = [];
  try {
    files = readdirSync(notesDirPath).filter((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
  for (const f of files) {
    try {
      for (const ln of readFileSync(join(notesDirPath, f), "utf8").split("\n"))
        if (FACT_RE.exec(ln)?.[1] === t) return true;
    } catch {
      /* unreadable file — skip */
    }
  }
  return false;
}

// Regenerate every thread tail from the recall db (digests preserved where the
// file already exists). Used on upgrade so pre-existing cached mail appears as
// files day one, and available any time the files drift.
export function rebuildThreads(
  dir: string,
  cache: Mailbox,
  book: ContactBook,
  me: string,
  now: number,
): number {
  secureDir(dir);
  // Everyone with any recorded traffic: saved contacts first, then any sender in
  // the db we don't have a book entry for (label falls back to a key prefix).
  const keys = new Set<string>();
  for (const c of book.contacts) if (c.signPub) keys.add(c.signPub);
  for (const r of historyFor(cache, me, null, { limit: 200 })) {
    const other = r.sender === me ? r.recipient : r.sender;
    if (other !== me) keys.add(other);
  }
  let built = 0;
  for (const key of keys) {
    const rows = historyFor(cache, me, key, { limit: TAIL_MAX_ENTRIES });
    if (!rows.length) continue;
    const name = contactByKey(book, key)?.name ?? senderLabel(book, key);
    const path = threadFilePath(dir, name, key);
    const existing = findThreadFile(dir, key);
    let digest = "";
    if (existing) {
      try {
        digest = splitFile(readFileSync(existing, "utf8")).digest;
      } catch {
        /* regenerate */
      }
    }
    const blocks = rows.map((r) => ({
      at: r.created_at,
      block: renderEntry({
        direction: r.sender === me ? "out" : "in",
        who: r.sender === me ? "me" : senderLabel(book, r.sender),
        body: r.body,
        at: r.created_at,
        assistant: r.answered_by === "assistant",
      }),
    }));
    if (existing && existing !== path) {
      try {
        renameSync(existing, path);
      } catch {
        /* keep old name */
      }
    }
    writeSecretAtomic(path, renderFile(name, digest, trim(blocks, now)));
    built++;
  }
  return built;
}

// ---- notes: the agent's fact memory (AUTO-CHAT.md `cli-chat-context`) --------

const TOPIC_RE = /^[a-z0-9-]{1,40}$/;

function topicFile(dir: string, topic: string): string {
  return join(dir, `${topic}.md`);
}

export function cleanTopic(raw: string | undefined | null): string {
  const t = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return TOPIC_RE.test(t) ? t : "general";
}

// A fact's audience: who may hear it when the assistant answers on the user's
// behalf. "private" (the default — user-only, never relayed), "anyone", or a
// tag name from the contact book ("work", "family"). Stored inline in the md
// line as `@<audience>` so hand-editing a note's reach is one word.
const AUD_RE = /^[a-z0-9][a-z0-9-]{0,24}$/;
export function cleanAudience(raw?: string): string {
  const a = (raw ?? "").toLowerCase().trim().replace(/^@/, "");
  return AUD_RE.test(a) ? a : "private";
}

// Append one dated fact to a topic file (created on first use). `source` is
// where the fact came from ("user", a contact name, an escalation id) so a later
// read can weigh it. One fact per line keeps the files greppable and lets the
// agent delete stale lines surgically.
export function rememberNote(
  dir: string,
  args: { text: string; topic?: string; source?: string; audience?: string },
  now: number,
): { topic: string; file: string; audience: string } {
  secureDir(dir);
  const topic = cleanTopic(args.topic);
  const path = topicFile(dir, topic);
  let prev = "";
  try {
    prev = readFileSync(path, "utf8");
  } catch {
    prev = `# ${topic}\n\n`;
  }
  const audience = cleanAudience(args.audience);
  const aud = audience === "private" ? "" : ` @${audience}`;
  const src = args.source ? ` (${args.source.replace(/[()\n]/g, " ").trim()})` : "";
  const line = `- ${new Date(now).toISOString().slice(0, 10)}${aud}${src}: ${args.text.replace(/\s*\n\s*/g, " ").trim()}\n`;
  writeSecretAtomic(path, prev.endsWith("\n") || prev === "" ? prev + line : prev + "\n" + line);
  return { topic, file: path, audience };
}

// Read the notes back — every topic, or ones matching a substring filter (topic
// name OR content). Small by construction; the caller renders/uses as needed.
//
// `forTags`: the audience gate (answer-once, 0.20). When set — recall is
// grounding an answer TO a contact — every fact line is filtered IN CODE before
// the model sees it: `@anyone` passes, `@<tag>` passes iff the contact has that
// tag, and everything else (including legacy untagged lines) is withheld —
// default-closed. Topics with no surviving fact stay out entirely. Same shape
// as the new-handle gate: withhold the data, don't ask the model to.
const FACT_RE = /^- \d{4}-\d{2}-\d{2}(?: @([a-z0-9-]+))?[ (:]/;
export function recallNotes(
  dir: string,
  q?: string,
  forTags?: string[] | null,
): { topic: string; content: string }[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const needle = q?.trim().toLowerCase();
  const allowed = forTags ? new Set(forTags.map((t) => t.toLowerCase())) : null;
  const out: { topic: string; content: string }[] = [];
  for (const f of files.sort()) {
    try {
      let content = readFileSync(join(dir, f), "utf8");
      const topic = basename(f, ".md");
      if (allowed) {
        const kept = content.split("\n").filter((ln) => {
          if (!ln.startsWith("- ")) return true; // headers / prose stay
          const m = ln.match(FACT_RE);
          const aud = m?.[1];
          return aud === "anyone" || (!!aud && allowed.has(aud));
        });
        if (!kept.some((ln) => ln.startsWith("- "))) continue; // nothing they may hear
        content = kept.join("\n");
      }
      if (!needle || topic.includes(needle) || content.toLowerCase().includes(needle))
        out.push({ topic, content });
    } catch {
      /* unreadable file — skip */
    }
  }
  return out;
}
