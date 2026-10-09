# T1 — Delete the Lorebook attachment wrappers that bypass the Conversation transaction

Status: TODO

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

- [ ] Confirm no production callers: `grep -rn 'attachLorebookToConversation\|saveLoreSettings(' src | grep -v test`
- [ ] Retarget the three tests onto the guarded command path
- [ ] Delete both wrappers and any import that becomes unused
- [ ] typecheck, lint, the three test files, `bun test`
- [ ] Commit

## Acceptance

`grep -rn 'attachLorebookToConversation\|saveLoreSettings' src` returns nothing.

## Outcome
