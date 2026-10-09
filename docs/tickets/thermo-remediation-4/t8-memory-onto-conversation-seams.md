# T8 — Memory and SillyTavern read Conversation through its seams

Status: DONE

Blocked By: T4

Source: issue #52, findings **F2** (blocker) and **F3**, plus the memory bullet of **§6 Modularity**.

## Problem

- F2: `src/server/memory/settings.ts` (~:87, `isMemoryEnabledForConversation`) and `src/server/memory/indexing.ts`
  (~:126-129, `claimMemoryIndexJob`) each hand-write
  `SELECT 1 FROM conversation_prompt_preset p JOIN prompt_preset_block b … b.reference='memory' AND b.enabled=1`.
  The canonical rule is `hasEnabledMemorySlot(recipe.slots)` in `shared/contract/prompt-preset` (used by
  `prompt-preset/blocks.ts` and `generation-plan/compiler.ts`). `memory/extraction.ts` (~:26, ~:40) runs
  `SELECT conversation_id FROM messages WHERE id = ?` and a `messages JOIN conversation_memory_settings` instead of going
  through `conversation/memory-read.ts`.
- F3: `memory/labels.ts` (~:117, plus 4 `participantTable` selects) and `sillytavern/prior-imports.ts` (~:107) read
  `conversationTable` directly; `conversation/read-data.ts` / `conversation/history.ts` already provide those reads.
- §6: `memory/collections.ts` calls `drizzle(database)` 19× (indexing 6×, labels 5×): one connect per function instead of
  `connect(database)` once per entry point like every other module.

## Files owned

`src/server/memory/{settings,indexing,extraction,labels,collections}.ts`, `src/server/sillytavern/prior-imports.ts`,
`src/server/conversation/memory-read.ts` (extend only), and their tests.

## Mechanics

- **Remove:** the three raw SQL strings and the duplicated memory-slot predicate; the 6 direct Conversation table reads; the per-function `drizzle(database)` calls.
- **Introduce:** one read on the existing Conversation memory-read seam (`conversationIdOfMessage` / `memoryNoteOf`, or extend
  `readConversationMemorySource`). `isMemoryEnabledForConversation` = `hasEnabledMemorySlot(readPromptPresetRecipeForConversation(...).slots)`.
  `claimMemoryIndexJob` filters on that in JS or takes the enabled-conversation set as input. Reads in labels / prior-imports call
  `readConversationData` / `readConversationSummary`.
- **Behavior changed:** `claimMemoryIndexJob` does one extra read per claim instead of a correlated subquery. Accepted (claims are per job).

## Rejected

- Moving the raw SQL unchanged into `conversation/memory-read.ts`: moves the drift, doesn't remove it.

## TODO

- [x] `isMemoryEnabledForConversation` on `hasEnabledMemorySlot`
- [x] `claimMemoryIndexJob` without the SQL predicate
- [x] `extraction.ts` onto the memory-read seam
- [x] `labels.ts` + `prior-imports.ts` onto conversation reads
- [x] `collections.ts` / `indexing.ts` / `labels.ts` single connect per entry point
- [x] typecheck, lint, check:contracts, `bun run test`
- [x] Commit
- [x] Review round 1: batched claim read, batched prior-import read, label-commands on the Conversation seam, tombstone labels restored

## Acceptance

`grep -rnE 'FROM (messages|conversation_prompt_preset)' src/server --include='*.ts' | grep -v conversation/` is empty;
`grep -c 'drizzle(database)' src/server/memory/collections.ts` ≤ 1.

## Outcome

**Removed.** The three raw SQL strings (`isMemoryEnabledForConversation`'s `SELECT 1 … conversation_prompt_preset`,
`claimMemoryIndexJob`'s candidate query with the `EXISTS (conversation_prompt_preset ⋈ prompt_preset_block …)` predicate,
and `extraction.ts`'s `SELECT conversation_id FROM messages` / `messages ⋈ conversation_memory_settings`) and the duplicated
memory-slot predicate are gone. So are the direct Conversation reads in scope: `labels.ts`'s `participantTable` select and
`prior-imports.ts`'s `conversationTable` name map plus per-candidate `reportJson` reads, and `label-commands.ts`'s
`participantTable` / `conversationTable` probes. `claimMemoryIndexJob` no longer materializes every eligible collection or
reads a recipe per candidate. `collections.ts`, `indexing.ts` and `labels.ts` each define one
`const connect = (database) => drizzle(database)` and route every construction through it.

**Introduced.** `conversation/memory-read.ts` gained `conversationIdOfMessage` and `memoryNoteOf` (the extraction seam) and
`readCastForMemory` — every Participant row in Cast order, tombstones included, with `MemoryCastMember.removed` stating
membership. `conversation/read-data.ts` gained `readConversationDataBatch(database, ids, filter)`; `readConversationData` is now
its single-id case. `prompt-preset/recipe.ts` gained `readConversationPromptPresetRecipes(database, ids)` — one selection read
plus batched header and block reads for the distinct presets. `memory/settings.ts` gained
`readMemoryEnabledConversationIds(database, ids)` = `hasEnabledMemorySlot(recipe.slots)` over that batch;
`isMemoryEnabledForConversation` stays the single-Conversation rule. `claimMemoryIndexJob` selects the distinct candidate
Conversations with the claim predicates, filters their ids through the batched slot read, then claims the earliest row with
`LIMIT 1`; no candidate row and no per-candidate recipe is read.

**Behavior changed.** `claimMemoryIndexJob` does batched reads per claim (accepted in the ticket) instead of per-candidate
reads. Memory label rules see every Participant row again, tombstones included, restoring pre-T8 behavior (verified against
`git show cd58b06~1:src/server/memory/labels.ts`, whose select had no `deleted_at` filter).
`isMemoryEnabledForConversation` reads the selected recipe instead of joining the tables itself. No wire change.

**Review round 1 (findings 1–4).** Finding 1: the full `.all()` of eligible collections plus `.find()` recipe reads is
replaced by the distinct-Conversation read, the `readMemoryEnabledConversationIds` batch and an ordered `LIMIT 1` claim; the
reviewer's 20-disabled-candidate probe now reads no recipe per candidate (one batch for the shared preset), and an idle poll
returns after the candidate read without touching presets. Selection order (earliest `updated_at`), the immediate transaction
and one job per call are unchanged. Finding 2: the per-candidate `readConversationData` calls became one
`readConversationDataBatch` over bounded 500-id batches; duplicate classification is untouched. Finding 3:
`label-commands.ts` checks active membership through `readCastForMemory(...).find(({ id, removed }) => id === … && !removed)`
and existence through `conversationExists`. Finding 4: the old code included removed Participants, so that behavior is restored
through `readCastForMemory`; the tombstone sentinel position 0 keeps the same row order Memory consumed before T8. A new
`src/server/memory/indexing.test.ts` covers finding 1's behavior: three older complete candidates whose Conversations have no
enabled Memory slot, plus a newer enabled one, and the enabled job is the one claimed (no SQL-statement assertions).

- Gates (final state): `bun run typecheck` exit 0 (0 errors; an earlier run while the concurrent client ticket was mid-edit reported
  12 errors confined to `src/client/workspace/useAssemblyController.ts`). `bun run lint` exit 0 (349 pre-existing warnings, no
  errors). `bun run check:contracts` exit 0 (11 pre-existing suspicious cross-layer matches). `bun run test` 1357 pass / 0
  fail (155 files); `bun test src/server/memory` 8 pass / 0 fail, `bun test src/server/sillytavern` 88 pass / 0 fail,
  `bun test src/server/contract` 369 pass / 0 fail (no timeouts).
- Acceptance 2: `grep -c 'drizzle(database)' src/server/memory/collections.ts` → 1 (the `connect` helper; indexing 6→1, labels 2→1).
- Acceptance 1: no match in any Memory/SillyTavern file. One pre-existing match remains out of scope: `src/server/database/chat.ts:9`
  (moved to T11 by `351482c`; not in this ticket's files).
