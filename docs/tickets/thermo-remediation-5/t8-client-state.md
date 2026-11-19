# T8: Client state

Status: IN PROGRESS

Blocked By: T7

Model: Sol 6.2 high writes and fixes slices a, b and c. Astra 6 high writes d; Sol 6.2 high fixes it. Reviewer: Sonnet 5.5 high.

Slices a and b ship as one PR: both move server data into the query cache, in different files.

**Slice c: the owner approved the overlay model. Invariant fixes and regression verification are complete; the PR remains under review.**

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
- [x] Slice c invariant fixes and CI verification
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

Invariants for the current fix round (recorded before implementation):

1. Transcript commands read the newest accepted Conversation revision at dispatch from the query cache; the command queue accounts for preceding writes. Displayed history is never a command revision source. Exact draft saves outside the transcript retain their explicit base.
2. Every history read commits through one gate: all pages have one revision, equal to the accepted Summary and no older than the displayed window. Only the current visit and unsuperseded window may commit. Failed navigation retains the readable window; Summary advancement still schedules its refresh.
3. Each visit has a unique cache identity across selections and remounts. Missing initial source anchors open latest history; an existing window survives a missing anchor. Failed initial reads remain recoverable through normal selection and Jump to latest.
4. Every optimistic selection or Moves request either settles with its accepted revision, is refused, or is displaced before dispatch. Displacement retires the unsent request; a later refusal preserves the earlier accepted value until authoritative history replaces it. Ending a visit discards its overlays and prevents queued commands from sending.
5. Paging has one observable owner for deduplication, cancellation and the loading indicator. A stale completion cannot clear a newer operation's activity.
6. Navigation failures are reported in the transcript and consumed at the event boundary; Inspector and trace clicks cannot create unhandled rejections.

- One committed window per Chat visit lives in the query cache. The story reducer holds Preview, requested selections, requested Moves and an unplaced Generation. Successful selection and Moves overlays stay visible until history reaches their applied Revision.
- Removed the Chat-open, history adoption and revision-refetch effects and the navigation `flushSync`. Initial opens, explicit refreshes, write-triggered refreshes, paging and jumps all commit through the same function. It rejects mixed or older revisions and reconciles the Conversation Summary before publishing a newer window.
- `paging follows the current edge and deduplicates rapid calls independently of window size` covers deduplication, older prepend and row identity. `newer paging extends a detached window and generation refresh retains that complete window` covers newer append.
- `a source jump supersedes paging without allowing the old completion to extend its window` and `a Conversation write supersedes a pending older page at the latest anchor` cover late responses after their window was superseded. `a late older page from another revision cannot extend the current window` and `a late newer page from another revision cannot extend the current window` cover a server revision change during paging and a successful retry after refresh.
- `Preview blocks a later Swipe and sends only the older Variant confirmed by the writer` checks the local Preview, downstream blocking, and the Confirm command. `reloading the Chat discards an unconfirmed Swipe Preview` checks the same selected Variant after a browser reload. The session test also checks a remount with a warm history cache. Streaming cases moved to `story/variant-streams.test.ts`.
- Failed reads, including a 404 for a deleted source anchor, report an error and leave the displayed window and independent reads intact. A successful jump supersedes older navigation. After an anchor changes, late reads for its old window cannot commit.
- Every read retries obsolete or inconsistent results up to three total attempts. A paging mismatch refreshes the current window before the writer can request another page. A write that joins a completing refresh triggers another read if that refresh did not cover the write's revision. Tests cover failed jumps during write refresh, write-triggered retry, older anchor responses, the revision sent by Delete after a jump, and a 404 during refresh.
- A refused Swipe or Moves edit reveals the previous accepted value until history catches up. The assembly test renders the Requested Send placeholder before and after history places it.
- Changed-file lint and `git diff --check` passed locally. BuildBuddy passed `bun run check`. The PR's Check workflow also runs the browser suite.

- Current invariant coverage: `edit / save as new / Moves uses accepted writes while displayed history is held behind` and `a retained command callback reads newly accepted authority before React renders` cover command authority; `a failed jump that advances Summary refreshes the window the reader stays on` and `accepted authority supersedes a Summary reconciliation without stranding its history refresh` cover reconciliation, including cancellation by a write.
- `opening a Chat at a missing source opens its latest Messages`, `reselect / latest recovers an initial history failure`, and `a remount with a warm cache opens latest instead of the previous visit's detached window` cover recovery and visit isolation.
- `coalescing Swipes across Messages retires the displaced unsent selection` covers overlay displacement; existing Swipe/Moves refusal tests cover preserving prior accepted values. `leaving a visit cancels its queued command before dispatch without blocking the next visit` covers cancellation before send.
- `a cancelled page cannot clear the replacement page's loading indicator` covers the observable paging lifecycle, alongside the rapid-call deduplication test. Paging activity is now one subscribed controller; no test asserts its implementation shape. The obsolete first-write stop instructions were removed by document review, without a tautological document test.
- The source-jump browser flow now forces a missing Inspector source, checks that the transcript remains readable and reports failure, then retries successfully. The browser fixture rejects unhandled promise rejections. Inspector, trace and Prompt Plan preview share one event handler that consumes navigation failures.
- Changed-file lint passed (two pre-existing comment warnings in the command runner). Unit tests, typecheck and browser tests are delegated to PR CI; no such checks ran on this host in this round.

- [BuildBuddy regression verification](https://app.buildbuddy.io/invocation/de3938eb-3c5e-4ed3-b4a4-f4fc14bbb93c): 82 focused tests passed. Restoring the five production modules from `9e7b4959` (adapting only the renamed revision-reader input in the test harnesses) made 11 new behavioral checks fail: edit, save-as-new, Moves, retained callback, failed-jump reconciliation, missing initial source, both recovery controls, warm-cache remount, displaced Swipe and abandoned queued command. The extra reconciliation cancellation case passed on the baseline too; it is invariant coverage, not a claimed new repro.

- [Source-click regression verification](https://app.buildbuddy.io/invocation/d24fa0aa-fd49-4d33-bfba-36e706255e24): the browser flow passed; restoring the original uncaught Inspector/trace/preview callbacks made the same flow fail on the unhandled `The Chat history could not be loaded.` rejection.
- [CI check](https://github.com/TanJeeSchuan/DitzyTavern/actions/runs/44539051007) passed for implementation head `4930028e`, including typecheck and the full unit suite. This final documentation update runs the same checks again.

- Final visit audit: overlay dispatch now rejects ended visits at its single boundary, and selection aborts the visit synchronously rather than waiting for React cleanup. `an overlay callback retained from an ended visit cannot change the reopened Chat` and `batched reselection ends the visit before old queued work or overlays can run` both fail on `9e7b4959`. [Final focused verification](https://app.buildbuddy.io/invocation/2289fa54-fc16-4d78-9cb2-2bc677d1ba3c): 84 passed; restoring baseline production modules yields 13 regression failures. The approved `StoryOverlays` shape and displayed-Variant precedence remain unchanged.
