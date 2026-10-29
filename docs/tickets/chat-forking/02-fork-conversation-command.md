# Fork Conversation command

Status: DONE

Blocked By: 01

Source: `docs/specs/chat-forking.md`, User Stories 6–13, 15–19; Implementation Decisions 1–2, 4–7; ADR-0052.

## Goal

`fork-conversation` copies a Chat through a fork point into a new Chat in one transaction, with a Fork link back, and `unlink-fork` removes the link.

## Ownership

- Conversation schema, migration and snapshot read (Fork link)
- `src/server/workflows` (the fork workflow) and `src/server/conversation/commands`
- HTTP command contract

## Work

- [x] Add `forked_from_conversation_id` and `forked_from_message_id` to `conversation`, both `ON DELETE SET NULL`, with a check that the message is null whenever the Chat is. Return the link with the source's current name in the Conversation read.
- [x] Add `fork-conversation` `{ at: { through, variantId? } | { rewind }, trimVariants, name, expectedRevision }`. Refuse a stale revision, an Active Generation, a Message outside the Chat, a `variantId` not on the `through` Message, and a `rewind` Message that isn't Human-authored.
- [x] Rewind: copy the Messages before the `rewind` Message, possibly none, and return its selected text and its Moves rewritten through the id map.
- [x] Copy, building id maps for Participants, Messages and Variants as rows are inserted: the Cast with removed Participants, their prompts, openings, data and lorebook attachments; Control; Messages through the fork point with their author and context pairs remapped; Variants (only selected ones with `trimVariants`), selecting `variantId` on the fork point when given; `messages_data`; `message_variant_data`; `conversation_data`; Generation Settings; the preset selection; Chat lorebook attachments and lore settings; the background.
- [x] Rewrite every Box value through `rewriteRowReferences`: setup, Chat values, Participant values, Moves and record slots fail on a missing id; trace entries keep it. A Box that isn't loaded is left out of all of those, and its id is returned.
- [x] Skip Import provenance, the Canonical Source Archive, the Exact Source Artifact, captures and replays.
- [x] Add revisioned `unlink-fork`.
- [x] Contract tests: Macro State, a World Clock fold and a Race fold read the same in the Fork as in the source at the fork point; `trimVariants` leaves one Variant per Message; `variantId` is selected and its later Messages are absent; a Memory record citing a trimmed Variant fails naming the Box and path, while a trace citing one forks; an unloaded Box's data is absent and named; a Fork of a Fork links to its own source; deleting the fork point keeps the Chat link; deleting the source clears it; edits in the Fork leave the source unchanged; forking during an Active Generation is refused; a Race started after the fork point is running in the Fork with no Stretch yet; a Rewind of the first Message makes a Fork with no Messages; a Rewind returns the Message's text and Moves and copies nothing from it.
- [x] Run focused tests, typechecking, and the full test suite.
- [x] Set this ticket to DONE and commit.

## Acceptance

- A failed Fork writes nothing.
- No row in the Fork references a source row, except trace ids to rows the Fork didn't copy.
