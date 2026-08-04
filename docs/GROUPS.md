# Group chats (0.24)

A group is a **client-side object — the server never learns it exists**. Every
group message is N individually-sealed 1:1 sends; what makes them a group is a
`group` block inside each sealed envelope, which receivers use to cohere the
copies into one shared thread. Zero server/schema changes.

## Semantics

- **Multi-recipient send is a group by default.** "write Niels, Tobias and
  Mette: hey" reuses the group with exactly that membership or creates one on
  the spot (auto-named "Niels, Tobias & Mette", renameable). Separate 1:1
  copies only when the user explicitly asks.
- **Everyone sees everything**: members see the roster; a reply
  (`in_reply_to` on a group message) fans to the whole roster. A private aside
  is a fresh 1:1 send.
- **Tag sends stay 1:1** — "write everyone from work" never becomes a shared
  thread by itself (tags are private labels).

## Wire format

Inside the sealed body (envelope v1, optional field — full back-compat):

```json
"group": {
  "id":   "g<hex>",          // stable thread key, minted at creation
  "name": "project-x",
  "mid":  "<uuid>",           // canonical message id, same across all copies
  "roster": [{ "name", "signPub", "boxPub" }, …],  // full membership incl. sender
  "op":   "create|add|remove|leave|rename"          // control messages only
}
```

- Each copy gets its own transport id (the mailbox keys on it); every member
  stores the message under `mid`, so replies thread identically everywhere.
- The **roster rides every message** and is authoritative: receiving one
  message teaches/heals the whole group (name + membership). Roster names are
  members' **self-names**, never the sender's private nicks.
- Sanity rules on receive: the roster is applied only from a **saved, ungated
  sender**, who must themselves appear in the roster they assert (except
  `leave`, where their absence is the assertion). If the roster no longer
  includes the user, their copy flips to `left` (removed).

## Membership

Flat, cooperative (v1): any member can add/remove/rename; every change is an
ordinary message in the thread (the removed person gets it as a final notice).
Honest limits: removal can't retract messages someone already holds; `leave`
keeps local history readable and refuses new sends (`left_group`). Cap:
64 members.

## The new-handle gate

A first-time sender writing into a group the user is already in — group id
known locally and the sender present in its **stored** roster — comes through
ungated: being brought in by a member is the introduction. Any other stranger
is held as usual; a forged group claim vouches for nothing (the id is random
and known only to members, and an asserted roster is never trusted from a
held sender). Covered both ways in `test/integration/groups.test.ts`.

## Storage

- `book.groups` in contacts.json (`{id, name, members, createdAt, left?}`) —
  rides the vault sync like the rest of the book.
- Cache rows carry `group_id` + `group_name`; 1:1 pair queries exclude group
  rows (no bleed into personal threads); `history` accepts a group name.
- Thread file per group under `context/threads/`, keyed by group id.

## Auto chat

An auto-reply into a group is read by every member: grounding is the group's
own thread only (never any member's 1:1 thread — conduct rule 3), disclosure
at the strictest member's level.

## Deliberate v1 tradeoffs

- Pairwise sealing: N uploads/blobs per message — negligible at team scale;
  the upgrade path (shared group key, server fan-out, per-group sequence
  numbers) hangs off the same `group.id` if ever needed.
- Ordering by sender `created_at` (no total order), as in 1:1 threads.
- A group asserted by a still-gated sender isn't learned until after accept —
  the next member message heals it.
