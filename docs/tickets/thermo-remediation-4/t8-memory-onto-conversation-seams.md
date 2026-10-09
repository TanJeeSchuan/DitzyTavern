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

## Acceptance

`grep -rnE 'FROM (messages|conversation_prompt_preset)' src/server --include='*.ts' | grep -v conversation/` is empty;
`grep -c 'drizzle(database)' src/server/memory/collections.ts` ≤ 1.

## Outcome

**Removed.** The three raw SQL strings (`isMemoryEnabledForConversation`'s `SELECT 1 … conversation_prompt_preset`,
`claimMemoryIndexJob`'s candidate query with the `EXISTS (conversation_prompt_preset ⋈ prompt_preset_block …)` predicate,
and `extraction.ts`'s `SELECT conversation_id FROM messages` / `messages ⋈ conversation_memory_settings`) and the duplicated
memory-slot predicate are gone. So are the direct Conversation reads in scope: `labels.ts`'s `participantTable` select became
`readConversationSummary(...).cast`, and `prior-imports.ts`'s `conversationTable` name map plus its batched `reportJson` check
became per-candidate `readConversationData(...)` (name and readability from one seam call). F3's 6-site count included two reads
T4 had already relocated to `memory/label-commands.ts` (not owned here); those are untouched.

**Introduced.** `conversation/memory-read.ts` gained `conversationIdOfMessage` and `memoryNoteOf` (exported through the
Conversation barrel) as the seam `extraction.ts` uses. `isMemoryEnabledForConversation` is now
`hasEnabledMemorySlot(readConversationPromptPresetRecipe(...).slots)` (early-returning on the global Memory toggle), and
`claimMemoryIndexJob` selects candidates with a Drizzle query without the slot predicate, then `.find()`s the first row whose
Conversation is enabled — one recipe read per candidate instead of a correlated subquery. `collections.ts`, `indexing.ts` and
`labels.ts` each define one `const connect = (database) => drizzle(database)` and route every construction through it.

**Behavior changed.** `claimMemoryIndexJob` does extra reads per claim (accepted in the ticket); `readMemoryLabelState` now sees
the active Cast (tombstoned Participants are no longer offered to label rules, matching every other Cast read);
`isMemoryEnabledForConversation` reads the selected recipe instead of joining the tables itself. No wire change.

- Gates: `bun run typecheck` 0 errors; `bun run lint` exit 0 (no warnings on changed lines); `bun run check:contracts` exit 0
  (11 pre-existing suspicious cross-layer matches); `bun run test` 1360 pass / 0 fail.
- Acceptance 2: `grep -c 'drizzle(database)' src/server/memory/collections.ts` → 1 (the `connect` helper; indexing 6→1, labels 2→1).
- Acceptance 1: no match in any Memory/SillyTavern file. One pre-existing match remains out of scope: `src/server/database/chat.ts:9`
  (`listChatSummaries`, also present at the review commit and not in this ticket's files).
