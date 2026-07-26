// Browser-side persistence for the web client: localStorage stands in for the
// CLI's user dir (identity.json / contacts.json / session.json / inbox.db).
// The DATA SHAPES are the CLI's own (Identity, ContactBook, MessageRow,
// SessionState-equivalent) so vault and history sync interop unchanged; only
// where they live differs. Messages are capped — the server-side history
// stream is the durable copy, this is a window onto it.

import type { Identity } from "../../src/crypto.ts";

export interface WebSession {
  token: string;
  email: string;
  dataKey?: string;
  vaultVersion: number;
  historyCursor: number;
}

// Mirrors src/db.ts MessageRow (the history-chunk row shape).
export interface Row {
  id: string;
  recipient: string;
  sender: string;
  body: string;
  tags: string | null;
  created_at: number;
  fetched_at: number | null;
  read_at: number | null;
  in_reply_to: string | null;
  answered_by?: string | null;
}

export interface WebContact {
  name: string;
  selfName?: string;
  signPub?: string;
  boxPub?: string;
  handle?: string;
  email?: string;
  auto?: boolean;
  gated?: "pending" | "dismissed";
  tags?: string[];
  sentCount?: number;
  lastMessageAt?: number;
  [k: string]: unknown; // preserve fields other clients set (verified, tagMeta…)
}

export interface WebBook {
  me: string;
  contacts: WebContact[];
}

// The user's own model-provider connection (assist.ts). Key never leaves this
// browser; baseUrl only set for the "custom" OpenAI-compatible provider.
export interface AssistConfig {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const NS = "cco.";
const MAX_ROWS = 2000;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    /* quota — the durable copy lives server-side */
  }
}

export const store = {
  loadIdentity: () => read<Identity>("identity"),
  saveIdentity: (id: Identity) => write("identity", id),

  loadSession: () => read<WebSession>("session"),
  saveSession: (s: WebSession) => write("session", s),

  loadBook: () => read<WebBook>("contacts"),
  saveBook: (b: WebBook) => write("contacts", b),

  // Last server vault blob (decrypted JSON string) — the base we graft local
  // identity/contacts onto when pushing, so settings/context files another
  // device synced are carried through untouched, never dropped.
  loadVaultBase: () => read<string>("vaultBase"),
  saveVaultBase: (raw: string) => write("vaultBase", raw),

  loadRows: () => read<Row[]>("rows") ?? [],
  saveRows(rows: Row[]): void {
    if (rows.length > MAX_ROWS) {
      rows = [...rows].sort((a, b) => a.created_at - b.created_at).slice(-MAX_ROWS);
    }
    write("rows", rows);
  },

  // History rows queued for the next push (the CLI's history-outbox.jsonl).
  loadOutbox: () => read<Row[]>("outbox") ?? [],
  saveOutbox: (rows: Row[]) => write("outbox", rows),

  // Pinned contacts (signPubs) — device-local UI preference, like CLI tags.
  loadPins: () => read<string[]>("pins") ?? [],
  savePins: (p: string[]) => write("pins", p),

  // Bring-your-own-model assist config. Legacy "aiKey" entries (v1: Anthropic
  // only) migrate transparently.
  loadAssist(): AssistConfig | null {
    const cfg = read<AssistConfig>("assist");
    if (cfg?.apiKey) return cfg;
    const legacy = read<string>("aiKey");
    return legacy ? { provider: "anthropic", apiKey: legacy } : null;
  },
  saveAssist(cfg: AssistConfig | null): void {
    localStorage.removeItem(NS + "aiKey");
    if (cfg?.apiKey) write("assist", cfg);
    else localStorage.removeItem(NS + "assist");
  },

  wipe(): void {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(NS)) localStorage.removeItem(k);
    }
  },
};
