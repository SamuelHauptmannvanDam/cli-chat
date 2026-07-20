# Contacts of contacts

An easy way to reach people in your network — a third section under `contacts`
showing your contacts' contacts (second-degree), each tagged with who they come
`via`. Not a discovery/nag product: a list you look at and connect from — via a
connect request they accept (see [FRIENDS.md](FRIENDS.md), which layers the
consent handshake over this graph).

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
The join traverses **confirmed (mutual) edges only** — both directions of each
edge must exist, so only genuine two-way friendships propagate. The shipped SQL
lives in [FRIENDS.md §4a](FRIENDS.md). `:me` is the *verified* pubkey from the
signed request — you can only ever compute your own network. The join runs in
D1's engine (not Worker CPU), so it stays well under the Workers free-tier
10 ms CPU/request limit.

## Response per person
`{ signPub, name, mutuals, via: [names] }` where `name` is the person's own
self-name. **No `handle` and no `boxPub`** — a discovered person is name-only and
unreachable until they accept a connect request (FRIENDS.md §4a). `via` is shown
(`· via Niels`) AND kept in the object so relational addressing works ("the
Tobias Niels knows" → the entry with `via:["Niels"]`). `mutuals` orders the
list; it is not displayed.

## Routes (all Ed25519-signed by the local identity)
- `POST /edges` `{contact}` | `{contacts:[...]}` — upsert (owner = verified pubkey).
- `DELETE /edges` `{contact}` — on contact delete.
- `GET /network` — runs the query, resolves each to handle + self-name.
- `POST /edges/hidden` — quiet opt-out.

## Client
- `update_contact` add → fire-and-forget `POST /edges`; delete → `DELETE /edges`.
  Best-effort, like the push warmer — never blocks the user.
- **One-time backfill** on upgrade: push existing local contacts as one batch so
  nobody starts empty.
- `contacts` gains a **Contacts of contacts** section from `GET /network`,
  rendered name-only (`name · via <contact>`); reaching one goes through
  `request_contact` (FRIENDS.md §5). Filter out anyone the user has deleted or
  dismissed.

## No caching, on purpose

The plain live query is the tier-correct choice: at current volume it sits
comfortably inside the free tier (the dominant cost is D1 rows-read — a heavy
user's pull reads ~10k rows against a ~5M/day cap), and a cache would add writes
+ invalidation logic for zero benefit. Revisit only if D1 analytics show
rows-read trending toward the cap or `/network` latency degrades.
