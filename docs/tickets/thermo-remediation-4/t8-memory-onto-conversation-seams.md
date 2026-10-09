# T8 — Memory and SillyTavern read Conversation through its seams

Status: TODO

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

- [ ] `isMemoryEnabledForConversation` on `hasEnabledMemorySlot`
- [ ] `claimMemoryIndexJob` without the SQL predicate
- [ ] `extraction.ts` onto the memory-read seam
- [ ] `labels.ts` + `prior-imports.ts` onto conversation reads
- [ ] `collections.ts` / `indexing.ts` / `labels.ts` single connect per entry point
- [ ] typecheck, lint, check:contracts, `bun run test`
- [ ] Commit

## Acceptance

`grep -rnE 'FROM (messages|conversation_prompt_preset)' src/server --include='*.ts' | grep -v conversation/` is empty;
`grep -c 'drizzle(database)' src/server/memory/collections.ts` ≤ 1.

## Outcome
