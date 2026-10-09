# T3 — Shrink the ActiveWritingWorkspace shell

Status: TODO

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

- [ ] Extract `useSaveNavigation`
- [ ] Extract theme hook; move toast state out of the shell
- [ ] Shell ≤ 350 lines, ≤ 5 `useState` (`grep -c useState`)
- [ ] typecheck, lint, `bun test`
- [ ] Manual browser check of save-guard navigation and theme
- [ ] Commit

## Outcome
