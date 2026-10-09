# T7 — Collapse `createConversationCommands` into `runConversationCommand`

Status: DONE

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

- [x] Reshape `runConversationCommand` around `surface` with defaulted callbacks
- [x] Migrate the 9 call sites; delete `createConversationCommands.ts`
- [x] Trim commentary that defended the split
- [x] typecheck, lint, `bun run test`
- [x] Commit

## Acceptance

`src/client/createConversationCommands.ts` does not exist; `grep -rn 'onNotPlayable\|onNotRemovable' src/client` shows only the runner and call sites with non-default behavior.

## Outcome

`createConversationCommands` is gone; `runConversationCommand(surface, command, options)` is the one seam.

- `ConversationCommandSurface` (`conversationId`, `revision`, `onConversationChange`, `setNotice`, `isCurrent?`)
  replaces the `revision` + `ConversationCommandReconciliation` pair and absorbs the wrapper's latest-wins
  guard: `isCurrent` is evaluated before every effect (adoption, notice, callback). The surface carries
  `conversationId` because an action is dispatched as
  `applyConversationCommand(conversationId, revision, action)`.
- `command` is either a `ConversationAction` (the action path the wrapper used to provide) or a
  `ConversationCommandSend`: the operation-carrying send seam, now the runner's own type.
- `ConversationCommandRunOptions` flattens the old `notices` + `callbacks` pair. `onNotPlayable` and
  `onNotRemovable` are optional and default to `surface.setNotice`; the default notice wording the wrapper
  held (`CONVERSATION_CONFLICT_RELOAD_NOTICE` / `CONVERSATION_UNREACHABLE_NOTICE`) moved into the runner.
- Deleted types: `ConversationCommandOptions`, `ConversationCommandReconciliation`,
  `ConversationCommandCallbacks`, `ConversationOperationOutcome`, `ConversationRevisionSource`.

Behavior: none on reachable paths. `not-playable` is only thrown for `create-message`/`create-variant`
and no client site sends those through the runner, so the old wrapper-only `not-playable` default
(`CONVERSATION_UNREACHABLE_NOTICE`) was unreachable; `not-removable` is only thrown for
`remove-participant`, whose one call site keeps its custom callback. Callback defaults removed at:
`useCastActions` (5 commands; kept the remove-participant `onNotRemovable`), `useGenerationSettingsDraft`
(the `onNotPlayable`/`onNotRemovable` options and their `showUnreachable` wiring), `usePreviewController`,
`AuthorNotePanel`, `ParticipantEditor`, `ComposerControls`, `usePromptPresetLibrary` (kept its
conflict-notice `onNotPlayable`), and `model-selection-command` (the `onUnavailable` option is gone).
`usePromptPresetLibrary`'s selection states `conversationOperationApplies` once, as the surface's
`isCurrent`, instead of four restated guards; the callback-local guards are gone because the runner
guards every effect. `commitConversationModel` lost its `conversation` argument (the surface carries
the id and revision). Runner commentary: 34% → 22% of the file, 174 → 130 lines.

Verification: `bun run typecheck` exit 0; `bun run lint` exit 0 (no warning in a changed file);
`bun run check:contracts` exit 0; `bun test src/client` 285 pass / 0 fail; `bun run test` 1360 pass / 0 fail.

Acceptance: deleted as required; `grep -rn 'onNotPlayable\|onNotRemovable' src/client` matches only the
runner (definition, defaulting, and test) plus the two non-default callbacks named above. No residuals.
