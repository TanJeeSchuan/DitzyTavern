# T7 — Collapse `createConversationCommands` into `runConversationCommand`

Status: TODO

Blocked By: T5

Source: issue #52, finding **F8**.

## Problem

`src/client/conversation-command-runner.ts` (173 lines, 34% comments) exposes `ConversationCommandOptions / Reconciliation /
Notices / Callbacks / OperationOutcome` and **requires** `onNotPlayable` and `onNotRemovable` (~:75-76).
`src/client/createConversationCommands.ts` supplies defaults for both, yet 9 call sites still pass them:
`characters/useCastActions.ts` ×4, `workspace/useGenerationSettingsDraft.ts` ×3, `workspace/usePreviewController.ts`,
`AuthorNotePanel.tsx`, `workspace/prompt-preset/usePromptPresetLibrary.ts`, `ComposerControls.tsx`, `model-selection-command.ts`.
`usePromptPresetLibrary` restates `conversationOperationApplies` 4×.

## Files owned

`src/client/conversation-command-runner.ts`, `src/client/createConversationCommands.ts` (deleted), the 9 call-site files above, their tests.

## Mechanics

- **Remove:** `createConversationCommands.ts`; required-ness of the two callbacks; the restated callbacks at the 9 sites;
  the 4 restated `conversationOperationApplies`; ~50 lines of commentary explaining the split.
- **Introduce:** `runConversationCommand` takes the `surface` (`revision`, `onConversationChange`, `setNotice`, `isCurrent`) directly
  and defaults the two callbacks to `setNotice`.
- **Behavior changed:** none. A call site keeps a custom callback only if it does something other than `setNotice`.

## TODO

- [ ] Reshape `runConversationCommand` around `surface` with defaulted callbacks
- [ ] Migrate the 9 call sites; delete `createConversationCommands.ts`
- [ ] Trim commentary that defended the split
- [ ] typecheck, lint, `bun run test`
- [ ] Commit

## Acceptance

`src/client/createConversationCommands.ts` does not exist; `grep -rn 'onNotPlayable\|onNotRemovable' src/client` shows only the runner and call sites with non-default behavior.

## Outcome
