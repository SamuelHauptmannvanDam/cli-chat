# Contacts of contacts

An easy way to write people in your network — a third section under `contacts`
showing your contacts' contacts (second-degree), each tagged with who they come
`via`. Not a discovery/nag product: a list you look at and write from, like any
contact.

## Principles
- **Convenience first.** No consent step, no "make yourself discoverable" prompt,
  no interruptions. On by default. A quiet "don't list me" opt-out exists but is
  never surfaced.
- **Everyone contributes, auth or not.** Edges are pushed by the **local identity**
  (the Ed25519 keys everyone already has for sending mail) — no email/online
  account required. The online account stays purely about multi-device vault sync.
- **Bare graph only.** The edge store holds `signPub → signPub` and nothing else.
  **No tags, no nicknames.** Tags are local and never leave the device. A person
  is shown by *their own* self-name, never by a nickname someone gave them.

## Data model (D1 + the node store, same schema)
```sql
CREATE TABLE IF NOT EXISTS edges (
  owner    TEXT NOT NULL,       -- signPub of the saver
  contact  TEXT NOT NULL,       -- signPub of the saved contact
  added_at INTEGER NOT NULL,
  PRIMARY KEY (owner, contact)
);
CREATE INDEX IF NOT EXISTS idx_edges_owner   ON edges (owner);
CREATE INDEX IF NOT EXISTS idx_edges_contact ON edges (contact);

CREATE TABLE IF NOT EXISTS edge_hidden (      -- quiet opt-out, never surfaced
  signpub TEXT PRIMARY KEY,
  since   INTEGER NOT NULL
);
```

## The query (server-side, one signed request)
```sql
SELECT e2.contact, COUNT(*) AS mutuals, GROUP_CONCAT(e1.contact) AS via
FROM edges e1
JOIN edges e2 ON e2.owner = e1.contact
WHERE e1.owner = :me
  AND e2.contact <> :me
  AND e2.contact NOT IN (SELECT contact FROM edges WHERE owner = :me)
  AND e2.contact NOT IN (SELECT signpub FROM edge_hidden)
GROUP BY e2.contact
ORDER BY mutuals DESC, MAX(e2.added_at) DESC
LIMIT 50;
```
`:me` is the *verified* pubkey from the signed request — you can only ever compute
your own network. The join runs in D1's engine (not Worker CPU), so it stays well
under the Workers free-tier 10 ms CPU/request limit.

## Response per person
`{ handle, name, signPub, mutuals, via: [names] }` where `name` is the person's own
self-name. `via` is shown (`· via Niels`) AND kept in the object so relational
addressing works ("write the Tobias Niels knows" → the entry with `via:["Niels"]`).
`mutuals` orders the list; it is not displayed.

## Routes (all Ed25519-signed by the local identity)
- `POST /edges` `{contact}` | `{contacts:[...]}` — upsert (owner = verified pubkey).
- `DELETE /edges` `{contact}` — on contact delete.
- `GET /network` — runs the query, resolves each to handle + self-name.
- `POST /edges/hidden` — quiet opt-out.

## Client
- `add_contact` → fire-and-forget `POST /edges`; `delete_contact` → `DELETE /edges`.
  Best-effort, like the push warmer — never blocks the user.
- **One-time backfill** on upgrade: push existing local contacts as one batch so
  nobody starts empty.
- `contacts` gains a **Contacts of contacts** section from `GET /network`; each row
  resolves to a handle so "write \<name>" works. Filter out anyone the user has
  deleted or dismissed.

---

# Caching — the plan for WHEN it makes sense (not now)

**Right now: no cache. The plain live query is the tier-correct choice.** At launch
volume it sits comfortably inside the free tier, and any cache would add D1 writes +
invalidation logic for zero benefit. Caching earns its keep only when real usage
signals say so.

### Current tier (the budget we're spending against)
- **Workers free:** ~100k requests/day; ~10 ms CPU per request. (The join is D1's,
  so Worker CPU is a non-factor here.)
- **D1 free:** ~5M rows read/day; ~100k rows written/day; 5 GB.

The dominant cost is **D1 rows-read**: one `/network` pull reads roughly
`(your contacts) + (sum of your contacts' contact counts)`. A heavy user ≈ 10k
rows/pull; a typical user, a few hundred. ~5M/day leaves a lot of headroom.

### Triggers — add caching when ANY of these holds (watch Cloudflare D1 analytics)
1. **D1 rows-read sustained above ~50% of the daily cap** (≈2.5M/day), or clearly
   trending to hit it within a month.
2. **`/network` p95 latency degrades** (large joins) enough to feel slow.
3. **A meaningful cohort of high-fan-out users** (many pulls reading >~20k rows).

### What to add, in order (each cheap, staleness is fine — this is a slow-changing
convenience list, so serving a slightly old list is harmless)
1. **Client-side snapshot (do this first).** Cache the `/network` result locally;
   refresh lazily — on demand, after the user's own contact changes, or piggybacked
   on the existing sync. Kills most repeat pulls, **adds zero server writes**, fits
   the local-first model. Biggest win for the least cost.
2. **Server-side TTL row (if rows-read still high).** A `coc_cache(owner, json,
   computed_at)` table: serve if fresh (e.g. < 6 h), else recompute + upsert. Turns
   the ~10k-row join into a **1-row read** on most pulls; costs 1 write per
   recompute (trivial against 100k/day).
3. **Fan-out cap (alongside either).** Skip contacts whose degree exceeds a
   threshold (whale guard) and/or expand only your top-N contacts. The only lever
   that cuts rows-read at the source; changes results, so gate it behind real need.

### What to AVOID
- **Materialize-on-write** — recomputing the instant any edge changes: one edge
  write invalidates *everyone who has that person*, causing a write storm. The
  TTL/lazy approach sidesteps it.
- **Cloudflare KV cache** — free write cap (~1k/day) is too low for write-through.
- **HTTP/edge cache** — requests are per-user and signed, so not cacheable.

**Rule:** ship the plain live query; revisit caching only on the triggers above,
client-snapshot first.

## Build order (v1, now)
1. `edges` + `edge_hidden` tables (additive migration, like the auth tables).
2. Server routes + query + tests against the node store.
3. Client edge push (add/delete) + one-time backfill.
4. `contacts` rendering + resolve-to-handle + deleted/dismissed filter.
5. Deploy Worker; verify end-to-end with two accounts sharing a contact.
