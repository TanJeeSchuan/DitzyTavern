# T8: Client state

Status: IN PROGRESS

Blocked By: T7

Model: Sol 6.2 high writes and fixes slices a, b and c. Astra 6 high writes d; Sol 6.2 high fixes it. Reviewer: Sonnet 5.5 high.

Slices a and b ship as one PR: both move server data into the query cache, in different files.

**Slice c: the owner approved the overlay model. Current phase and guarantees are recorded once in Outcome below.**

The rule, from `CODING_STANDARDS.md`: server data lives in the query cache. A reducer or `useState` holds only what the user has done that the server does not know yet. Each slice removes a second copy of server data and the code that kept it in step.

Read ADR 0002, 0023, 0029, 0031 and 0036. Evidence: reports 05, 06, 14 and 19. The tests each slice rewrites, and the guarantee each must keep, are in report 25's change-coupling table (rows 1, 2, 4, 5, 8).

Behaviour stays the same unless a slice says otherwise. Verify each slice by hand in the browser as well as by test; keep the `playwright-cli` session open while iterating and stop your servers with `bun run dev:stop`.

## Slice a: three hand-rolled reads become queries

Report 19, findings 5 and 10.

- Delete `src/client/chat-info.ts` and its test. `ChatInformationPanel` reads Import Details with a query and downloads the source with a mutation. Keep today's "no retry until reopened" behaviour (`retry: false`). The check that the download is disabled when the artifact is gone moves to `e2e/import.spec.ts`.
- The Character list (`NewChatPanel`, `CharactersPanel`) and the Chat list (`ChatsPanel`) become queries that the relevant commands invalidate. Delete the effects, the manual refetch callbacks and the props that only carried them.

## Slice b: the Prompt Preset editor

Report 14, finding 1 and its state-machine description.

- The two queries the editor already runs own its data. Delete the reducer's copy (`view`), the session id, read and operation claims, `pendingRetire`, the `alive` ref, the `flushSync` dispatch, `load`, `loadRecipe` and both adopt effects.
- Drafts are component state in a component keyed by Conversation and preset. After a save, await the refetch, then drop the drafts that are still the objects that were submitted.
- Keep the pure rules `draftToPatch`, `dirtyBlockPatches` and `draftIsDirty` and their six tests. Delete the nineteen tests of the session machine.
- Leaving with unsaved edits goes through the shared `SaveGuard`. Switching preset asks through `useNavigationRequest`. Delete `usePromptPresetLeave` and `UnsavedBlockEditDialog`. The preset panel also renders under Paint, outside the navigation provider; give that surface the provider or switching there will not ask.
- Guarantees to keep, each with a test or an e2e check: a save in flight cannot be dismissed with Escape; text typed during a save survives the save's refresh; a response for a Chat or preset the editor has left changes nothing; only one operation runs at a time.
- Amend ADR 0036: the editor is in the primary panel, and block toggles are drafts saved with the panel; only ordering persists immediately.

## Slice c: the transcript window

Reports 05, finding 2; 06, finding 2.

- The Message window is derived from the history query's pages. `story.ts` keeps overlays only: Preview, requested selection, requested Moves, and the placeholder for a Generation the page has not placed yet. Delete the reducer's Message and Variant tree, the effect that copies pages into it, and the revision reconciliation between the two.
- A successful command updates the cached read or leaves its overlay in place until the invalidated read returns.
- Keep per-Variant stream subscriptions (`story/variant-streams.ts`): they stop every token from re-rendering the whole transcript. Keep row identity stable so memoised Messages do not re-render on a page load.
- Guarantees to keep: rapid paging calls are deduplicated; older pages prepend and newer append; a late page from a superseded read does not extend the window; Preview blocks a selection further down; an older Variant selection is local until confirmed; a reload drops a client-only Preview.
- Rewrite `story.test.ts` around those guarantees. Move its streaming tests to `story/variant-streams.test.ts`.

## Slice d: one owner for a Generation

Report 06, finding 1; report 05, findings 3 and 5.

- One owner holds a Generation from the local start through observation, keyed by Generation id once accepted. Delete `src/client/pending-generation-starts.ts`, the double dispatch on acceptance in `useGenerationController`, and the effect that retires the pending entry.
- ADR 0031 still holds: leaving a Chat unsubscribes without stopping; a detached session resumes from its cursor; Stop is explicit.
- `useGenerationController` stops returning `stopGeneration` and `activeGenerationMessageIds`; the test that calls `stopGeneration` goes through `cancelGeneration`.
- Ordinary Swipe selection and Confirm Change share one selection transaction.
- Guarantees to keep: an accepted Generation the page has not placed keeps streaming; a Chat switch never resumes from a discarded cursor; reconnects stay bounded; a Stop from an older visit cannot settle a newer one.

## Rejected

- Moving connection settings and the Lorebook editor onto `useRevisionedDraft`, the import flow's state union, and New Chat's Definition form: not scheduled.
- Returning the new block id from the add-instruction route.
- Replacing the Variant stream store with reducer updates.

## TODO

- [x] Slices a and b, one PR, ADR 0036 amended
- [x] Slice c overlay model approved
- [x] Slice c owner revision decision, invariant fixes and regression verification
- [ ] Slice d (Astra), fixes (Sol), PR

## Acceptance

`src/client/chat-info.ts`, `src/client/pending-generation-starts.ts`, `usePromptPresetLeave.ts` and `UnsavedBlockEditDialog.tsx` do not exist. `git grep -n -E 'ReadClaim|OperationClaim|pendingRetire|flushSync' -- src/client` is empty for the Prompt Preset editor, and slice c removes the transcript session's `flushSync`. The Lorebook editor is outside this ticket. Each guarantee listed above has a named test or e2e check in the Outcome. Typecheck, unit tests and e2e pass in CI on each slice.

## Outcome

### Slices a and b

- Import Details and the Character and Chat lists read the query cache. Commands invalidate affected lists. Import source download is a mutation. The Chat information reducer and its tests were removed.
- Prompt Preset drafts are scoped to the Conversation and resolved preset. The shared SaveGuard handles closing and switching. The editor waits for a recipe refresh before retiring submitted drafts. The reducer, response claims, and private leave flow were removed.
- The desktop import e2e removes the source artifact and checks the disabled download and missing-file message.
- `Escape cannot dismiss a prompt save that is still running` exercises the shared guard.
- `text typed during a Prompt Preset save survives its refresh` exercises edits while the refresh is held.
- `a response from a Prompt Preset editor that was left cannot publish a Conversation` holds a selection response until the editor unmounts.
- `a late recipe read leaves the newly opened preset intact` and `Back to Paint asks before discarding Paint Preset edits` cover the preset read and Paint navigation.
- `a Prompt Preset save blocks another operation until its refresh settles` tries to select a preset in the same turn as starting a save.
- Six pure draft and patch tests remain. Changed-file lint and `git diff --check` passed. The seeded browser check exercised the Chat and Character lists, source download and cleanup, Prompt Preset save-and-leave, and Paint Preset discard. The slices a and b PR ran the Check workflow.
- `Save and leave keeps a draft overwritten by another Prompt Preset editor` verifies that an overwrite during the save leaves the draft unsaved and blocks navigation.
- `a failed recipe read after switching presets hides the old editor` verifies that the panel shows the error when the selected preset's recipe fails to load.
- `a Prompt Preset draft survives a failed recipe read for the same Chat` verifies that editing and saving are disabled during the failure, SaveGuard still prompts, and the draft returns when the recipe reloads.

### Slice c

Current phase: Round five review fixes are in [PR #291](https://github.com/TanJeeSchuan/DitzyTavern/pull/291).

1. **Owner decision, 2026-11-19.** Transcript commands carry the revision of the displayed history used to build them. An inline draft retains its base until the user confirms an overwrite. Save and leave processes one draft at a time. It waits for displayed history between saves and checks the draft's original Variant and Content before using the displayed revision. The server rejects stale commands with a 409. After an accepted write, transcript Save, Save and leave, Moves, Swipe and Delete stay disabled until displayed history catches up. Remove Fork link carries the revision of the Summary that supplied the link.
2. The committed window is the sole owner of its revision. Every read commits through one gate: consistent pages, no revision regression, current visit and window. The refresh scheduler stores no revision. Summary advancement refreshes the window only when needed; a successful jump does not cause a duplicate destination read.
3. Each visit has a client-local identity that survives remount collisions and works on HTTP LAN origins. Selecting a different Chat retires the old owner synchronously. Retrying the current Chat keeps its visit, rows, drafts and generation owner.
4. A missing source anchor switches to latest during an open, jump or refresh. The latest read gets its own bounded consistency budget, including when the last source attempt returns 404. A source request can open its window while the initial history read is pending. If a history read fails, the existing window stays readable and the transcript offers Jump to latest. Shared Summary requests have their own cancellation signal.
5. Every optimistic request settles, is refused, or is displaced before dispatch. Ending a visit discards its overlays and prevents old callbacks and queued commands from changing the replacement visit. The approved `StoryOverlays` model and displayed-Variant precedence stay intact.
6. One request owns paging at a time. A page extends the currently committed window when the revision and requested edge still match, including after a same-revision checkpoint refresh. Failed source reads that cannot recover show the history error in the transcript.

Coverage for the guarantees above:

- `conversation-session.test.ts`: `edit`, `save as new` and `Moves refuses to overwrite unseen authority with a stale transcript` verify revision-checked refusal without replacing another tab's work. `Delete uses the displayed history revision after a source jump` holds history one revision behind the Summary. `a retained transcript command keeps its displayed revision before React renders` covers retained callbacks. `rapid Swipes coalesce without borrowing the preceding write revision` covers queued writes. `an exact command without a displayed base cannot borrow a queued revision` covers an unavailable draft base.
- `requested-state.spec.ts`: `accepted writes disable transcript controls until displayed history catches up` holds the read after an accepted write, checks Save, Save and leave, Moves, Swipe, Delete and an already-open Swipe browser, then releases history and checks that controls recover. `story-sync.spec.ts` retains the two-tab conflict and explicit overwrite check. Its Save and leave scenarios exercise two unrelated drafts and a concurrent change to the second draft's Variant. `chat-forking.spec.ts` removes a Fork link using its Summary while its first history page is held.
- `conversation-session.test.ts`: `a successful newer source jump reads its destination once without a spurious error`, `a failed jump that advances Summary refreshes the window the reader stays on`, and `refresh stops retrying stale pages and keeps the newer cached window` cover the single commit gate and revision owner.
- `visits reopen latest history with crypto.randomUUID unavailable`, the warm-cache remount test, and `selectChat retires a queued command before dispatch and leaves the replacement visit usable` cover client-local visits. `retrying an active Chat keeps readable rows and its pending generation through another failure` and the browser test `retrying the active Chat preserves the unsent composer draft and readable transcript` cover in-place recovery.
- `a missing initial source on the final consistency attempt still opens latest` and `Jump to latest survives cancellation of an unrelated refresh sharing its Summary` cover fallback budgeting and cancellation ownership. The active Chat retry tests cover deletion of a displayed source on both the latest and an older page. `a source request can open before the first transcript page arrives` holds the first page and checks the source rows and scroll target.
- `coalescing Swipes across Messages retires the displaced unsent selection` and the refused/accepted Swipe tests check what subsequent history displays; none assert overlay map contents. Preview locality, downstream blocking, reload discard, stable row identity and page ordering remain covered by `story.test.ts`, `useStoryMessageActions.test.ts`, `conversation-session.test.ts` and `requested-state.spec.ts`.
- `paging survives a same-revision refresh that changes the live checkpoint` counts one paging request and checks both the added rows and the refreshed checkpoint. `a cancelled page cannot clear the replacement page's loading indicator` covers replacement ownership. `story-jump.spec.ts` observes the latest read after an Inspector source 404 and the next source request, then checks paging, latest navigation and sending.

Remote verification: 103 focused tests and typecheck passed; all 10 requested-state/story-sync browser cases passed; the Inspector source-jump flow passed 10 repetitions. Against `c9427309`, the 11 new revision/navigation probes, the missing-base runner test and both browser regressions fail for the intended reasons. See the [focused baseline run](https://app.buildbuddy.io/invocation/eaaae86c-85de-476e-8d1b-2f26d0586701) and [final regression run](https://app.buildbuddy.io/invocation/28450fa1-6131-4ed0-9d15-05cb876d63b9). Changed-file lint and `git diff --check` passed locally; tests and typecheck were not run on this host.
