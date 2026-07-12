// Cloudflare D1 adapter for the mailbox Store. Same three operations as the
// node:sqlite adapter, against D1's async prepared-statement API. Used by
// worker.ts at deploy time. Untested locally (needs wrangler/Miniflare) — the
// Node adapter is the dev/test path; this is the production target.

import type {
  AcceptedRecord,
  AccountRecord,
  FriendRequestRecord,
  HandleRecord,
  LoginPoll,
  MailSummary,
  NetworkPerson,
  Store,
  VaultRecord,
} from "./store.ts";
import type { WireMessage } from "../src/identity.ts";
import { randomId } from "./token.ts";

// Minimal shape of the D1 binding we use.
export interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      all(): Promise<{ results: unknown[] }>;
      first(): Promise<unknown>;
    };
  };
}

export function d1Store(db: D1Like): Store {
  return {
    async put(m: WireMessage, receivedAt: number = m.created_at) {
      await db
        .prepare(
          `INSERT INTO messages (id, recipient, sender, body, tags, created_at, received_at, fetched_at, in_reply_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(m.id, m.recipient, m.sender, m.body, m.tags, m.created_at, receivedAt, m.in_reply_to)
        .run();
      // Directed "known pair": sender → recipient. Exempts the recipient's reply
      // from new-sender throttling, and marks this sender known once they reply.
      await db
        .prepare(`INSERT OR IGNORE INTO known (owner, peer, created_at) VALUES (?, ?, ?)`)
        .bind(m.sender, m.recipient, receivedAt)
        .run();
    },

    async summary(recipient: string): Promise<MailSummary[]> {
      const { results } = await db
        .prepare(
          `SELECT id, sender, created_at, in_reply_to FROM messages
           WHERE recipient = ? AND fetched_at IS NULL ORDER BY created_at ASC`,
        )
        .bind(recipient)
        .all();
      return results as MailSummary[];
    },

    async drain(recipient: string, now: number): Promise<WireMessage[]> {
      // One atomic mark-and-return (see node store): avoids the SELECT-then-UPDATE
      // race that could mark a just-arrived message fetched without delivering it,
      // and collapses N per-row updates into a single statement (stays under the
      // Workers subrequest cap on large drains). Rows are marked, not deleted, so
      // the anti-spam counts are unaffected. RETURNING is unordered → sort after.
      const { results } = await db
        .prepare(
          `UPDATE messages SET fetched_at = ? WHERE recipient = ? AND fetched_at IS NULL
           RETURNING id, recipient, sender, body, tags, created_at, in_reply_to`,
        )
        .bind(now, recipient)
        .all();
      const rows = results as WireMessage[];
      rows.sort((a, b) => Number(a.created_at) - Number(b.created_at));
      return rows;
    },

    async registerHandle(handle: string, signPub: string, boxPub: string, now: number, name?: string) {
      const existing = (await db
        .prepare(`SELECT signPub FROM handles WHERE handle = ?`)
        .bind(handle)
        .first()) as { signPub: string } | null;
      if (existing && existing.signPub !== signPub) return "taken";
      await db
        .prepare(
          `INSERT INTO handles (handle, signPub, boxPub, name, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(handle) DO UPDATE SET boxPub = excluded.boxPub,
             name = COALESCE(excluded.name, handles.name)`,
        )
        .bind(handle, signPub, boxPub, name ?? null, now)
        .run();
      return "ok";
    },

    async resolveHandle(handle: string): Promise<HandleRecord | null> {
      const row = (await db
        .prepare(`SELECT signPub, boxPub, requests_only FROM handles WHERE handle = ?`)
        .bind(handle)
        .first()) as { signPub: string; boxPub: string; requests_only: number } | null;
      if (!row) return null;
      return { signPub: row.signPub, boxPub: row.boxPub, requestsOnly: !!row.requests_only };
    },

    async isRegistered(signPub: string): Promise<boolean> {
      const row = await db
        .prepare(`SELECT 1 FROM handles WHERE signPub = ? LIMIT 1`)
        .bind(signPub)
        .first();
      return row != null;
    },

    async purge(readBefore: number, unreadBefore: number): Promise<number> {
      const res = (await db
        .prepare(
          `DELETE FROM messages
           WHERE (fetched_at IS NOT NULL AND fetched_at < ?) OR created_at < ?`,
        )
        .bind(readBefore, unreadBefore)
        .run()) as { meta?: { changes?: number } };
      return Number(res?.meta?.changes ?? 0);
    },

    async isKnownSender(recipient: string, sender: string): Promise<boolean> {
      const row = await db
        .prepare(`SELECT 1 AS x FROM known WHERE owner = ? AND peer = ? LIMIT 1`)
        .bind(recipient, sender)
        .first();
      return row != null;
    },

    async countRecentFromPair(recipient: string, sender: string, since: number): Promise<number> {
      const row = (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE recipient = ? AND sender = ? AND received_at >= ?`,
        )
        .bind(recipient, sender, since)
        .first()) as { n?: number } | null;
      return Number(row?.n ?? 0);
    },

    async countRecentUnknown(recipient: string, since: number): Promise<number> {
      const row = (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m
           WHERE m.recipient = ? AND m.received_at >= ?
             AND NOT EXISTS (
               SELECT 1 FROM known k WHERE k.owner = m.recipient AND k.peer = m.sender
             )`,
        )
        .bind(recipient, since)
        .first()) as { n?: number } | null;
      return Number(row?.n ?? 0);
    },

    async countRecentSentToNew(sender: string, since: number): Promise<number> {
      const row = (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m
           WHERE m.sender = ? AND m.received_at >= ?
             AND NOT EXISTS (
               SELECT 1 FROM known k WHERE k.owner = m.recipient AND k.peer = m.sender
             )`,
        )
        .bind(sender, since)
        .first()) as { n?: number } | null;
      return Number(row?.n ?? 0);
    },

    // --- Account layer ------------------------------------------------------
    async getOrCreateAccount(email: string, now: number): Promise<AccountRecord> {
      const e = email.toLowerCase();
      const found = (await db
        .prepare(`SELECT id, email, signPub, paid, data_key FROM accounts WHERE email = ?`)
        .bind(e)
        .first()) as
        | { id: string; email: string; signPub: string | null; paid: number; data_key: string | null }
        | null;
      if (found)
        return {
          id: found.id,
          email: found.email,
          signPub: found.signPub,
          paid: !!found.paid,
          dataKey: found.data_key,
        };
      const id = randomId();
      await db
        .prepare(
          `INSERT INTO accounts (id, email, signPub, paid, created_at, updated_at)
           VALUES (?, ?, NULL, 0, ?, ?)`,
        )
        .bind(id, e, now, now)
        .run();
      return { id, email: e, signPub: null, paid: false, dataKey: null };
    },

    async bindAccountSignPub(accountId: string, signPub: string, now: number) {
      await db
        .prepare(`UPDATE accounts SET signPub = ?, updated_at = ? WHERE id = ?`)
        .bind(signPub, now, accountId)
        .run();
    },

    async ensureDataKey(accountId: string, candidate: string, now: number): Promise<string> {
      await db
        .prepare(`UPDATE accounts SET data_key = ?, updated_at = ? WHERE id = ? AND data_key IS NULL`)
        .bind(candidate, now, accountId)
        .run();
      const row = (await db
        .prepare(`SELECT data_key FROM accounts WHERE id = ?`)
        .bind(accountId)
        .first()) as { data_key: string | null } | null;
      return row?.data_key ?? candidate;
    },

    async setAccountPaid(accountId: string, now: number) {
      await db.prepare(`UPDATE accounts SET paid = 1, updated_at = ? WHERE id = ?`).bind(now, accountId).run();
    },

    async createLoginToken(tokenHash: string, email: string, pollId: string, expiresAt: number, now: number) {
      await db
        .prepare(
          `INSERT INTO login_tokens (token_hash, email, poll_id, consumed_at, expires_at, created_at)
           VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .bind(tokenHash, email.toLowerCase(), pollId, expiresAt, now)
        .run();
    },

    async consumeLoginToken(tokenHash: string, now: number): Promise<boolean> {
      const res = (await db
        .prepare(
          `UPDATE login_tokens SET consumed_at = ?
           WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .bind(now, tokenHash, now)
        .run()) as { meta?: { changes?: number } };
      return Number(res?.meta?.changes ?? 0) > 0;
    },

    async pollLogin(pollId: string, now: number): Promise<LoginPoll> {
      const row = (await db
        .prepare(`SELECT email, consumed_at, expires_at FROM login_tokens WHERE poll_id = ?`)
        .bind(pollId)
        .first()) as { email: string; consumed_at: number | null; expires_at: number } | null;
      if (!row || row.expires_at <= now) return { status: "expired" };
      if (row.consumed_at == null) return { status: "pending" };
      return { status: "ready", email: row.email };
    },

    async claimLogin(pollId: string) {
      await db.prepare(`DELETE FROM login_tokens WHERE poll_id = ?`).bind(pollId).run();
    },

    async createSession(tokenHash: string, accountId: string, expiresAt: number, now: number) {
      await db
        .prepare(
          `INSERT INTO sessions (token_hash, account_id, created_at, expires_at, last_seen)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(tokenHash, accountId, now, expiresAt, now)
        .run();
    },

    async accountBySession(tokenHash: string, now: number): Promise<AccountRecord | null> {
      const row = (await db
        .prepare(
          `SELECT a.id, a.email, a.signPub, a.paid, a.data_key, s.expires_at
           FROM sessions s JOIN accounts a ON a.id = s.account_id
           WHERE s.token_hash = ?`,
        )
        .bind(tokenHash)
        .first()) as
        | {
            id: string;
            email: string;
            signPub: string | null;
            paid: number;
            data_key: string | null;
            expires_at: number;
          }
        | null;
      if (!row || row.expires_at <= now) return null;
      await db.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).bind(now, tokenHash).run();
      return {
        id: row.id,
        email: row.email,
        signPub: row.signPub,
        paid: !!row.paid,
        dataKey: row.data_key,
      };
    },

    async deleteSession(tokenHash: string) {
      await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
    },

    async getVault(accountId: string): Promise<VaultRecord | null> {
      const row = (await db
        .prepare(`SELECT blob, version FROM vault WHERE account_id = ?`)
        .bind(accountId)
        .first()) as { blob: string; version: number } | null;
      return row ? { blob: row.blob, version: Number(row.version) } : null;
    },

    async putVault(accountId: string, blob: string, version: number, now: number) {
      const cur = (await db
        .prepare(`SELECT blob, version FROM vault WHERE account_id = ?`)
        .bind(accountId)
        .first()) as { blob: string; version: number } | null;
      if (cur && Number(cur.version) >= version)
        return { stale: { blob: cur.blob, version: Number(cur.version) } };
      await db
        .prepare(
          `INSERT INTO vault (account_id, blob, version, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET blob = excluded.blob,
             version = excluded.version, updated_at = excluded.updated_at`,
        )
        .bind(accountId, blob, version, now)
        .run();
      return "ok";
    },

    async appendHistory(accountId: string, blobs: string[], now: number): Promise<number> {
      for (const blob of blobs) {
        await db
          .prepare(
            `INSERT INTO history (account_id, seq, blob, created_at)
             SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM history WHERE account_id = ?`,
          )
          .bind(accountId, blob, now, accountId)
          .run();
      }
      const row = (await db
        .prepare(`SELECT MAX(seq) AS seq FROM history WHERE account_id = ?`)
        .bind(accountId)
        .first()) as { seq: number | null } | null;
      return Number(row?.seq ?? 0);
    },

    async historySince(accountId: string, since: number, limit: number) {
      const { results } = await db
        .prepare(
          `SELECT seq, blob FROM history WHERE account_id = ? AND seq > ?
           ORDER BY seq ASC LIMIT ?`,
        )
        .bind(accountId, since, limit)
        .all();
      const row = (await db
        .prepare(`SELECT MAX(seq) AS seq FROM history WHERE account_id = ?`)
        .bind(accountId)
        .first()) as { seq: number | null } | null;
      const chunks = (results as { seq: number; blob: string }[]).map((c) => ({
        seq: Number(c.seq),
        blob: c.blob,
      }));
      return { chunks, last: Number(row?.seq ?? 0) };
    },

    async deleteHistory(accountId: string) {
      await db.prepare(`DELETE FROM history WHERE account_id = ?`).bind(accountId).run();
    },

    async purgeAuth(now: number): Promise<number> {
      const a = (await db
        .prepare(`DELETE FROM login_tokens WHERE expires_at < ?`)
        .bind(now)
        .run()) as { meta?: { changes?: number } };
      const b = (await db
        .prepare(`DELETE FROM sessions WHERE expires_at < ?`)
        .bind(now)
        .run()) as { meta?: { changes?: number } };
      return Number(a?.meta?.changes ?? 0) + Number(b?.meta?.changes ?? 0);
    },

    // --- Contacts of contacts ----------------------------------------------
    async addEdges(owner: string, contacts: string[], now: number) {
      // No multi-row VALUES needed: dedup + upsert one at a time (batches are
      // small — a contact add is one, backfill a few). Skips self-edges.
      for (const contact of contacts) {
        if (!contact || contact === owner) continue;
        await db
          .prepare(
            `INSERT INTO edges (owner, contact, added_at) VALUES (?, ?, ?)
             ON CONFLICT(owner, contact) DO NOTHING`,
          )
          .bind(owner, contact, now)
          .run();
      }
    },

    async removeEdge(owner: string, contact: string) {
      await db.prepare(`DELETE FROM edges WHERE owner = ? AND contact = ?`).bind(owner, contact).run();
    },

    async contactsOfContacts(owner: string, limit: number): Promise<NetworkPerson[]> {
      // Mutual-only traversal (FRIENDS.md §4a): me⇄friend (e1/e1r) and friend⇄fof
      // (e2/e2r) must both exist, so only confirmed two-way friendships propagate.
      // Return NAME ONLY — no boxPub/handle — so discovery can't hand out send
      // capability; `signPub` is an opaque routing id for addressing a request.
      const { results } = await db
        .prepare(
          `SELECT e2.contact AS signPub, h.name AS name,
                  COUNT(*) AS mutuals, GROUP_CONCAT(e1.contact) AS via
           FROM edges e1
           JOIN edges e1r ON e1r.owner = e1.contact AND e1r.contact = e1.owner
           JOIN edges e2  ON e2.owner  = e1.contact
           JOIN edges e2r ON e2r.owner = e2.contact AND e2r.contact = e1.contact
           JOIN handles h ON h.signPub = e2.contact
           WHERE e1.owner = ?
             AND e2.contact <> ?
             AND e2.contact NOT IN (SELECT contact FROM edges WHERE owner = ?)
             AND e2.contact NOT IN (SELECT signpub FROM edge_hidden)
           GROUP BY e2.contact
           ORDER BY mutuals DESC, MAX(e2.added_at) DESC
           LIMIT ?`,
        )
        .bind(owner, owner, owner, limit)
        .all();
      return (results as {
        signPub: string;
        name: string | null;
        mutuals: number;
        via: string;
      }[]).map((r) => ({
        signPub: r.signPub,
        name: r.name,
        mutuals: Number(r.mutuals),
        via: r.via ? r.via.split(",") : [],
      }));
    },

    async hideFromNetwork(signPub: string, now: number) {
      await db
        .prepare(`INSERT INTO edge_hidden (signpub, since) VALUES (?, ?) ON CONFLICT(signpub) DO NOTHING`)
        .bind(signPub, now)
        .run();
    },

    // --- Friend requests (FRIENDS.md) --------------------------------------
    async createFriendRequest(from: string, to: string, via: string | null, now: number) {
      if (!to || to === from) return "self";
      const me = (await db
        .prepare(`SELECT boxPub, name FROM handles WHERE signPub = ? LIMIT 1`)
        .bind(from)
        .first()) as { boxPub: string; name: string | null } | null;
      if (!me) return "unregistered";
      const edge = await db
        .prepare(`SELECT 1 AS x FROM edges WHERE owner = ? AND contact = ? LIMIT 1`)
        .bind(from, to)
        .first();
      if (edge != null) return "already_friends";
      const res = (await db
        .prepare(
          `INSERT INTO friend_requests (to_signpub, from_signpub, from_boxpub, from_name, via_signpub, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(to_signpub, from_signpub) DO NOTHING`,
        )
        .bind(to, from, me.boxPub, me.name, via ?? null, now)
        .run()) as { meta?: { changes?: number } };
      return Number(res?.meta?.changes ?? 0) > 0 ? "ok" : "exists";
    },

    async listFriendRequests(to: string): Promise<FriendRequestRecord[]> {
      const { results } = await db
        .prepare(
          `SELECT from_signpub, from_boxpub, from_name, via_signpub, created_at
           FROM friend_requests WHERE to_signpub = ? ORDER BY created_at ASC`,
        )
        .bind(to)
        .all();
      return (results as {
        from_signpub: string;
        from_boxpub: string;
        from_name: string | null;
        via_signpub: string | null;
        created_at: number;
      }[]).map((r) => ({
        fromSignPub: r.from_signpub,
        fromBoxPub: r.from_boxpub,
        fromName: r.from_name,
        viaSignPub: r.via_signpub,
        createdAt: Number(r.created_at),
      }));
    },

    async acceptFriendRequest(acceptor: string, requester: string, now: number): Promise<AcceptedRecord | null> {
      const req = (await db
        .prepare(
          `SELECT from_boxpub, from_name FROM friend_requests
           WHERE to_signpub = ? AND from_signpub = ?`,
        )
        .bind(acceptor, requester)
        .first()) as { from_boxpub: string; from_name: string | null } | null;
      if (!req) return null;
      const meRow = (await db
        .prepare(`SELECT boxPub, name FROM handles WHERE signPub = ? LIMIT 1`)
        .bind(acceptor)
        .first()) as { boxPub: string; name: string | null } | null;
      await db
        .prepare(
          `INSERT INTO edges (owner, contact, added_at) VALUES (?, ?, ?)
           ON CONFLICT(owner, contact) DO NOTHING`,
        )
        .bind(acceptor, requester, now)
        .run();
      await db
        .prepare(
          `INSERT INTO edges (owner, contact, added_at) VALUES (?, ?, ?)
           ON CONFLICT(owner, contact) DO NOTHING`,
        )
        .bind(requester, acceptor, now)
        .run();
      if (meRow)
        await db
          .prepare(
            `INSERT INTO friend_accepts (to_signpub, peer_signpub, peer_boxpub, peer_name, created_at)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT(to_signpub, peer_signpub) DO UPDATE SET
               peer_boxpub = excluded.peer_boxpub, peer_name = excluded.peer_name`,
          )
          .bind(requester, acceptor, meRow.boxPub, meRow.name, now)
          .run();
      await db
        .prepare(`DELETE FROM friend_requests WHERE to_signpub = ? AND from_signpub = ?`)
        .bind(acceptor, requester)
        .run();
      return { signPub: requester, boxPub: req.from_boxpub, name: req.from_name };
    },

    async declineFriendRequest(acceptor: string, requester: string) {
      await db
        .prepare(`DELETE FROM friend_requests WHERE to_signpub = ? AND from_signpub = ?`)
        .bind(acceptor, requester)
        .run();
    },

    async takeAccepts(requester: string): Promise<AcceptedRecord[]> {
      const { results } = await db
        .prepare(
          `DELETE FROM friend_accepts WHERE to_signpub = ?
           RETURNING peer_signpub, peer_boxpub, peer_name`,
        )
        .bind(requester)
        .all();
      return (results as { peer_signpub: string; peer_boxpub: string; peer_name: string | null }[]).map(
        (r) => ({ signPub: r.peer_signpub, boxPub: r.peer_boxpub, name: r.peer_name }),
      );
    },

    // --- Handle controls (FRIENDS.md) --------------------------------------
    async setRequestsOnly(signPub: string, on: boolean, _now: number) {
      await db
        .prepare(`UPDATE handles SET requests_only = ? WHERE signPub = ?`)
        .bind(on ? 1 : 0, signPub)
        .run();
    },

    async rotateHandle(signPub: string, newHandle: string, now: number) {
      const mine = (await db
        .prepare(`SELECT boxPub, name, requests_only FROM handles WHERE signPub = ? LIMIT 1`)
        .bind(signPub)
        .first()) as { boxPub: string; name: string | null; requests_only: number } | null;
      if (!mine) return "no_identity";
      const taken = (await db
        .prepare(`SELECT signPub FROM handles WHERE handle = ?`)
        .bind(newHandle)
        .first()) as { signPub: string } | null;
      if (taken && taken.signPub !== signPub) return "taken";
      await db
        .prepare(
          `INSERT INTO handles (handle, signPub, boxPub, name, requests_only, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(handle) DO UPDATE SET
             boxPub = excluded.boxPub, name = excluded.name, requests_only = excluded.requests_only`,
        )
        .bind(newHandle, signPub, mine.boxPub, mine.name, mine.requests_only, now)
        .run();
      await db
        .prepare(`DELETE FROM handles WHERE signPub = ? AND handle <> ?`)
        .bind(signPub, newHandle)
        .run();
      return "ok";
    },
  };
}
