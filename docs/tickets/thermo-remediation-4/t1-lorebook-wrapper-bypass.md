# T1 — Delete the Lorebook attachment wrappers that bypass the Conversation transaction

Status: DONE

Blocked By: None

Source: issue #52, finding **F1**.

## Problem

`src/server/lorebook/attachments.ts` `attachLorebookToConversation` (~:84-87) and `saveLoreSettings` (~:270) call the
Conversation command handlers `attachConversationLorebook` / `saveConversationLoreSettings` on a bare `connect(database)`
handle. That skips the revision guard, `observeConversationWrites` and the memory-source sync ADR-0013 makes mandatory.
Production has zero callers; only tests keep them alive.

## Files owned

- `src/server/lorebook/attachments.ts`
- `src/server/workflows/generate.test.ts`, `src/server/workflows/generation-capture-coherence.test.ts`, `src/server/lorebook/evaluation.test.ts`
- `src/server/test-fixtures/conversation.ts` (only if the existing helper needs a small extension)

## Mechanics

- **Remove:** both wrappers and the `connect`-based pass-through.
- **Introduce:** nothing. The three tests use `executeConversationCommand` / the existing `test-fixtures/conversation.ts` helper, like every other test.
- **Behavior changed:** none in production. The tests now exercise the guarded path they claim to test.

## Rejected

- Wrapping the two helpers in `runConversationTransaction` inside the Lorebook module (keeps a second entry point to Conversation writes alive; re-creates the pattern round 3 G3 removed).

## TODO

- [x] Confirm no production callers: `grep -rn 'attachLorebookToConversation\|saveLoreSettings(' src | grep -v test`
- [x] Retarget the three tests onto the guarded command path
- [x] Delete both wrappers and any import that becomes unused
- [x] typecheck, lint, the three test files, `bun test`
- [x] Commit

## Acceptance

`grep -rn 'attachLorebookToConversation\|saveLoreSettings' src` returns nothing.

## Outcome

Both wrappers and the `attachConversationLorebook` / `saveConversationLoreSettings` import are gone from `src/server/lorebook/attachments.ts`; the acceptance grep over `src` is clean. The three tests moved onto the guarded command path:

- `generate.test.ts` attaches and saves settings through the fixture `applyCommand` seam (two chained commands), and the lifecycle's `expectedRevision` now follows the post-write revision, since every command advances the revision exactly once.
- `evaluation.test.ts` and `generation-capture-coherence.test.ts` dispatch `attach-chat` via `executeConversationCommand` and open their databases with the fixture `openObservedDatabase()` — an unobserved database throws `ConversationWriteObserverMissingError` the moment a lore command reports its memory change, which is exactly the guard the wrappers used to bypass. `test-fixtures/conversation.ts` needed no extension.

Verification: typecheck, lint, lint:rules, typecheck:tools, the three test files (29 pass), and full `bun test src` (1353 pass, 0 fail).
