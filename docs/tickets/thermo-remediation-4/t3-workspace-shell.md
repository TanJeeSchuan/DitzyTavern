# T3 — Shrink the ActiveWritingWorkspace shell

Status: Done

Blocked By: None

Source: issue #52, finding **F9**. Read `DESIGN.md` before touching UI. No UI/component/snapshot tests.

## Problem

`src/client/workspace/ActiveWritingWorkspace.tsx` (~606 lines) still holds 15 `useState`, 2 reducers, 8 controller hooks.
Save-guard navigation (`registerSaveGuard`, `requestNavigation`, `saveAndLeave`, `leaveAction` / `leaveSaving` /
`leaveError` / `guardPending`: 7 pieces of state for one dialog), theme persistence, toast state,
`markFailedModelTextOnly`, panel open/close state and workspace reload all live in the shell. `SaveGuard.tsx` already
owns the guard protocol; its navigation half lives in the shell.

## Files owned

- `src/client/workspace/ActiveWritingWorkspace.tsx`
- `src/client/SaveGuard.tsx`
- one new theme hook in `src/client/lib/`
- tests for pure logic you extract, if any non-tautological ones exist

## Mechanics

- **Remove:** the 7 save-guard state pieces and 3 handlers from the shell; the theme and toast `useState`s.
- **Introduce:** `useSaveNavigation()` next to `useSaveGuard` in `SaveGuard.tsx`, returning `{ requestNavigation, dialogProps }`;
  theme persistence as a ~5-line hook in `src/client/lib/`.
- **Target:** shell under 350 lines and at most 5 `useState`.
- **Behavior changed:** none. Verify by running the app (`playwright-cli` is installed) through: dirty editor → navigate → save-and-leave / discard; theme toggle persists across reload.

## TODO

- [x] Extract `useSaveNavigation`
- [x] Extract theme hook; move toast state out of the shell
- [x] Shell ≤ 350 lines, ≤ 5 `useState` (`grep -c useState`)
- [x] typecheck, lint, `bun test`
- [x] Manual browser check of save-guard navigation and theme
- [x] Commit

## Outcome

Shell is 341 lines with 3 `useState` (`grep -c useState` counts the import, giving 4). The save-guard
navigation half moved to `useSaveNavigation()` in `SaveGuard.tsx` (returns `{ requestNavigation,
dialogProps, registerSaveGuard }`; panel-side rename: the context-consumer hook is now
`useNavigationRequest`). Theme persistence lives in `src/client/lib/use-theme.ts`. Both the
generation-failure toast and the control-change toast became self-owned components
(`GenerationErrorToast.tsx`, `ControlChangeToaster.tsx`), including `markFailedModelTextOnly`.
Because the ≤ 5-state target left no room for detached detail state, `generationDetailsTarget` and
`memoryFocus` folded into the panel-coordination reducer: `generation-details-opened` carries the
target, `memories-opened` carries the focus, and every action that drops a surface drops the focus
data alongside it. The story stage (header, preview dock, message list, composer) moved to
`StoryStage.tsx`. Behavior unchanged; verified by playwright-cli through the dirty-editor
save/discard navigation and the theme toggle persisting across reload.

Review round 1: `StoryStage` now owns `useStoryViewport`, `useStoryMessageActions`, and the composer
focus (`isComposerFocused` + the `composerIsReceded` derivation), so no controller-hook result for
these three crosses a prop anymore. None of their results is consumed outside the stage
(`queueSwipeScroll`·`isAtLatest` feed the actions hook and the recede only, and the actions object
was only rendered), so nothing had to stay behind. The shell keeps solely the panel-coordination
callbacks, including one new `onEnterPreview` (dispatches `preview-entered` and closes the new-chat
surface). Shell: 317 lines, 2 `useState`. Checked by playwright-cli on send, regenerate, composer
focus/de-recede, and the scroll-away recede; jump-to-latest needs the Memories/generation-details
navigate-to-source path, which the dev seed has no data for, so it is covered by
`e2e/story-jump.spec.ts` instead.
