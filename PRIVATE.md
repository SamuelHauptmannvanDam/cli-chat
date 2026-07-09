# Private conversations — kept out of the agent's memory and mouth

**Status: on the board, not scheduled.** Not needed for the history MVP and
deliberately not next: the target user (developers) wants to give the agent
*more* context, not less — this matters later, when auto chat reaches
people whose mail isn't all work, or when a sensitive thread shows up in a
context pull and makes it concrete. Build the moment that happens; the
enforcement is a filter on history's query path, so it bolts on cleanly.

> **The pitch.** History makes your mail agent-readable context; auto chat
> makes it answerable. Some conversations should be neither. Mark a contact
> **private** ("keep my chats with Ana private" / "that conversation is
> classified") and everything with them becomes human-only: never pulled
> into a coding session as context, never auto-answered, never distilled
> into the agent's notes. You read and reply exactly as today.

## What "private" honestly means (scope, stated plainly)

Wire privacy already exists — every message is sealed E2E and the relay sees
only ciphertext. This feature is **agent hygiene on your own device**: it
controls what your AI may *reuse*, not who can *read* (nobody but the
recipient could anyway). On the recipient's side it's enforceable; a
sender-set flag on outgoing mail is **advisory** — you can't control the
other end's agent any more than you can control a human forwarding your
words. Don't oversell it as more than that.

## Level 1 — private contact (local, enforced; build this)

A `private: boolean` on `Contact` (a dedicated field, not a magic tag — tags
power group-send and suggestions, which private must never feed). Set/unset
conversationally: "make Ana private", "keep my chats with Ana out of your
context", "unmark Ana". Partial-name match + `no_contact`/`ambiguous`
handling like every contact tool. Shown in `contacts` (e.g. `Ana · private ·
k2m9q1`).

While a contact is private, the ENTIRE thread with them is exempt from every
agent-reuse path:

| Surface | Behaviour with a private contact |
|---|---|
| `history` tool | **Excluded by default.** Included only when the user explicitly asks for that thread by name ("show my history with Ana") — never swept into topic searches or "recent mail" pulls feeding a workflow. |
| Auto chat | **Never auto-answered.** Their messages always land in the needs-you feed. In quiet mode the interrupt says only *"a private message from Ana"* — the escalation never carries the body. |
| `cli-chat-context` | **Never written.** No facts, no notes, no escalation-answer saves from private threads. |
| Auto-tagging / `suggest_tags` | **Skipped entirely** — their bodies contribute no signals. |
| Normal reading/replying | Unchanged. Hooks announce count + sender as today; you read and reply like any mail. |

Storage: messages still land in the local store (otherwise "read it again"
breaks) — private is a query-time and behaviour-time filter, enforced at the
`history`/context layer, not a storage hole. The flag syncs with contacts in
the vault like any contact field.

## Level 2 — private send (wire-carried, advisory; small add-on)

"write Niels, private: …" packs `private: true` inside the sealed body
(invisible to the relay, back-compat like `answered_by`). A well-behaved
recipient agent honours it: surfaced to the human only, never auto-answered,
never saved to context, excluded from default history pulls. State the
limit in docs and in the agent's own mouth: *advisory* — it sets the default
for the other side's agent, it is not DRM.

## Not building (say why)

- **Burn-after-read / no-store mode** — real ephemerality fights the local-
  first cache, multi-device drain, and "read it again", for a guarantee the
  other end can't reciprocate anyway. Revisit only on real demand.
- **A separate "secret inbox" UI** — private mail flows through the normal
  inbox; only agent reuse is fenced. One inbox, one mental model.

## Build order

1. `Contact.private` + set/unset behaviour + `contacts` rendering.
2. Enforcement: `history` default-exclude; auto-chat always-surface (body-free
   quiet interrupt); `cli-chat-context` write-guard; tagging/suggestion skip.
3. Level 2: `private` in `packBody`/`unpackBody` + send trigger + recipient
   default behaviour.
4. CLAUDE.md + instructions.ts + resultNotes (the guard must ride the tool
   results, per the 0.6.1 lesson).
5. Tests: default-exclusion vs explicit-ask inclusion; no context writes; flag
   round-trip + back-compat.

## Open questions

1. **When to schedule.** Parked (see status). The natural trigger to revisit:
   auto chat reaching non-dev users, or the first real "that thread shouldn't
   have been in my context" moment. Enforcement is a filter on history's
   query path, so it bolts on whenever.
2. **Per-message local marking** ("make that one private") — probably falls
   out of Level 2's flag stored on the row; decide at build time.
3. **Default-private senders?** Unknown/stranger mail could be private-by-
   default until saved — overlaps the existing untrusted-content rules;
   likely unnecessary. Revisit if context pollution from strangers shows up.
