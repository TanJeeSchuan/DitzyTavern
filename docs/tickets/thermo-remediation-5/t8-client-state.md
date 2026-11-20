# T8: Client state

Status: DONE

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

- The Message window is derived from the history query's pages. `story.ts` keeps overlays only: Preview, requested selection, requested Moves, inline-edit drafts, and the placeholder for a Generation the page has not placed yet. Delete the reducer's Message and Variant tree, the effect that copies pages into it, and the revision reconciliation between the two.
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
- [x] Slice d first implementation and focused checks (Astra)
- [x] Slice d review fixes, full verification and PR (Sol)

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

Current phase: Round eleven review fixes for [PR #291](https://github.com/TanJeeSchuan/DitzyTavern/pull/291).

1. **Owner decision, 2026-11-19.** A command's payload and expected revision come from the same read. Inline Save, Save as new Swipe, Moves edits and Delete use the displayed history and are disabled while their Message has a requested Moves or selection overlay or while history is behind the latest accepted revision. A pending Swipe reserves its command queue slot when requested. Later Swipes coalesce in that slot until dispatch. A queued Swipe waits for displayed history to catch up with preceding client writes and checks whether its choice is still a direct selection. It drops a choice that now requires Preview. Save and leave processes one draft at a time and waits for displayed history between saves. Each draft keeps its original Variant and chosen save mode. When the draft’s original Variant and Content match the refreshed transcript, the first Save uses the refreshed revision. Overwriting changed Content requires a separate inline confirmation for that Variant and revision. The server rejects stale commands with a 409. Remove Fork link uses the Summary that supplied the link.
2. The committed window is the sole owner of its revision. Every read commits through one gate: consistent pages, no revision regression, current visit and window. The refresh scheduler stores no revision. A write that joins an in-flight refresh schedules a new read if the joined refresh leaves history behind. Summary advancement refreshes the window only when needed; a successful jump does not cause a duplicate destination read.
3. Each visit has a client-local identity that survives remount collisions and works on HTTP LAN origins. Selecting a different Chat retires the old owner synchronously. Retrying the current Chat keeps its visit, rows, drafts and generation owner.
4. A missing source anchor switches to latest during an open, jump or refresh, including after newer paging. The latest read gets its own bounded consistency budget. A source request checks the committed window and can open its own window while the initial read is pending. A newer navigation cancels the initial source scroll. If a read fails, the existing window stays readable and offers Jump to latest. Refresh rebuilds the range around the current source page when the source moves and keeps page 1 if the reader already paged through to latest. Shared Summary requests have their own cancellation signal.
5. Every optimistic request settles, is refused, or is displaced before dispatch. Ending a visit discards its overlays, cancels its pending frame waits and prevents old callbacks and queued commands from changing the replacement visit. The approved `StoryOverlays` model and displayed-Variant precedence stay intact.
6. Inline editors keep per-Message drafts in the visit overlays, including their original Variant, text and save mode. A source jump, automatic recovery, or Jump to latest can replace the visible rows. An editor reopens when its Message returns. SaveGuard prompts when closing the editor or preparing to leave the Chat. It applies an approved Discard when navigation commits. Canceling or refusing a Fork, Rewind, or New Chat leaves the current drafts intact. An off-window draft needs its Message back in the visible history before Save and leave can save it. Deleting the Message drops the draft.
7. One request owns paging at a time. A page extends the currently committed window when the revision and requested edge still match, including after a same-revision checkpoint refresh. Failed source reads that cannot recover show the history error in the transcript.

Coverage for the guarantees above:

- `conversation-session.test.ts`: `edit`, `save as new` and `Moves refuses to overwrite unseen authority with a stale transcript` verify revision-checked refusal. `fresh history cannot authorize a second removal from pending Moves` exercises an external Moves edit during a pending removal. `Delete uses the displayed history revision after a source jump` holds history one revision behind the Summary. `a retained transcript command keeps its displayed revision before React renders` covers retained callbacks.
- `useStoryMessageActions.test.ts`: `rapid Swipes coalesce and send the last choice from refreshed history` holds the refresh between sends. `a queued Swipe drops a Variant absent from refreshed history` covers a removed target. Two additional tests check a Swipe queued behind Moves and a direct selection that now needs Preview. `an edit is refused without sending while the Message's Swipe is pending` covers the write lock. In `conversation-command-runner.test.ts`, `an exact command without a displayed base cannot borrow a queued revision` covers an unavailable draft base.
- `requested-state.spec.ts`: `accepted writes disable transcript controls until displayed history catches up` checks the Message controls while a Moves write is pending, then holds the accepted write's history read and checks the transcript and the open Swipe browser. `story-sync.spec.ts` covers in-place conflict and explicit overwrite, a refused Save as new Swipe that remains a copy in Save and leave, unrelated drafts, and a concurrent change to a second draft's Variant. `chat-forking.spec.ts` removes a Fork link using its Summary while its first history page is held.
- `conversation-session.test.ts`: `a successful newer source jump reads its destination once without a spurious error`, `a failed jump that advances Summary refreshes the window the reader stays on`, and `refresh stops retrying stale pages and keeps the newer cached window` cover the single commit gate and revision owner.
- `visits reopen latest history with crypto.randomUUID unavailable`, the warm-cache remount test, and `selectChat retires a queued command before dispatch and leaves the replacement visit usable` cover client-local visits. `retrying an active Chat keeps readable rows and its pending generation through another failure` and the browser test `retrying the active Chat preserves the unsent composer draft and readable transcript` cover in-place recovery.
- `a missing initial source on the final consistency attempt still opens latest` and `Jump to latest survives cancellation of an unrelated refresh sharing its Summary` cover fallback budgeting and cancellation ownership. The active Chat retry tests cover deletion of a displayed source on both the latest and an older page. `a source request can open before the first transcript page arrives` holds the first page and checks the source rows and scroll target. `a newer source request retires the initial source's pending scroll` holds the scroll until the newer source is selected.
- `coalescing Swipes across Messages retires the displaced unsent selection` and the refused/accepted Swipe tests check what subsequent history displays; none assert overlay map contents. Preview locality, downstream blocking, reload discard, stable row identity and page ordering remain covered by `story.test.ts`, `useStoryMessageActions.test.ts`, `conversation-session.test.ts` and `requested-state.spec.ts`.
- `paging survives a same-revision refresh that changes the live checkpoint` counts one paging request and checks the added rows and refreshed checkpoint. `a cancelled page cannot clear the replacement page's loading indicator` covers replacement ownership. `newer paging preserves the anchor for deleted-source recovery` and `source navigation checks the committed window before React renders it` cover source recovery. `story-jump.spec.ts` checks source navigation, paging and sending, then verifies that an Inspector 404 returns a detached window to the latest reply and hides Jump to latest. The source refresh tests cover an append that shifts the source’s page in both a detached window and one that reaches latest.
- `story-sync.spec.ts` covers draft retention across Inspector source jumps, deleted-source recovery and Jump to latest after a history error. It also covers deleting a draft's own off-window Message and checks that Save and leave retains the original Variant after an external Swipe selection.
- `Write accepts the first input before the next frame while reading older Messages` covers the composer focus handoff. Clicking Write moves focus when the revealed composer commits, and the receded form is inert during its exit transition.

Remote verification: 103 focused tests and typecheck passed; all 10 requested-state/story-sync browser cases passed; the Inspector source-jump flow passed 10 repetitions. Against `c9427309`, the 11 new revision/navigation probes, the missing-base runner test and both browser regressions fail for the intended reasons. See the [focused baseline run](https://app.buildbuddy.io/invocation/eaaae86c-85de-476e-8d1b-2f26d0586701) and [final regression run](https://app.buildbuddy.io/invocation/28450fa1-6131-4ed0-9d15-05cb876d63b9). Changed-file lint and `git diff --check` passed locally; tests and typecheck were not run on this host.

Round eight baseline verification reproduced the two draft losses, the two queued Swipe failures, and the missing source in the refreshed range on `d9b412dd`. The deterministic composer focus regression also failed on that head and passed with the focus change. [Unit baseline](https://app.buildbuddy.io/invocation/fd22b95a-60a9-4542-84f1-b53d3b27a6e3), [browser baseline](https://app.buildbuddy.io/invocation/2c239b54-5e1a-4bf1-a000-279c027806ad), [focus baseline](https://app.buildbuddy.io/invocation/0896f5a6-9ef8-475e-a823-94713bb034ba).

BuildBuddy passed typecheck, tools typecheck, 111 focused tests and all 155 browser tests. The separate Write focus regression passed after the change. The unchanged story-jump flow still failed once in 55 repeated runs at the second Send. The baseline reproduction captured focus on the composer, no browser input events and an empty draft at submit with no active Generation. The owner accepted the intermittent browser timeout as a known flake for this slice. The historical PR #282 failure and the first `9cc26b85` attempt both timed out at Send exact plan on the first Send. [Full browser run](https://app.buildbuddy.io/invocation/af35cf47-bd3f-4b1a-bc4b-0b451893b042), [instrumented baseline](https://app.buildbuddy.io/invocation/b9e66ab0-cabf-46e4-9c15-65aa40349008), [repeat run with the focus fix](https://app.buildbuddy.io/invocation/146bbd1f-8bb3-40c1-96c6-85d79087b1e3).

Round nine covers a queued Swipe whose visit retires while animation frames are held, the first inline Save after an unrelated rename, New Chat creation after the unsaved draft decision, and focus on the narrow composer after adding from Gallery. The duplicate New Chat reproduced on `5e0ee77f`. The equivalent flow on master opened a single Chat. [Baseline regressions](https://app.buildbuddy.io/invocation/6f4ac044-61e5-42f6-8da4-a5b40c2c9d21), [duplicate reproduction](https://app.buildbuddy.io/invocation/334e5fac-904e-4dfe-aa85-e094622128c8), [master comparison](https://app.buildbuddy.io/invocation/e0bd0b52-b332-4344-ab5b-7c39e0ee7f3a).

Round nine BuildBuddy verification passed typecheck, 151 focused unit tests and 33 browser tests. The final New Chat regression fails on `5e0ee77f` because the Chat already exists after Keep editing. Changed-file lint and `git diff --check` passed locally. [Final verification](https://app.buildbuddy.io/invocation/958d65c9-f244-482b-8b14-62e4af493eb3), [New Chat baseline](https://app.buildbuddy.io/invocation/b6dc1cc4-a430-43b6-b260-7a60e77f8fb0).

Round ten verified that a refused New Chat preserves the inline draft after Discard, and that an accepted write recovers a failed joined history read both with and without a committed transcript. Both behaviours failed on `8d978fe3`. Typecheck, 153 focused unit tests and 31 browser tests passed on BuildBuddy. Changed-file lint and `git diff --check` passed locally. [Baseline regressions](https://app.buildbuddy.io/invocation/2d117f5e-117c-4cf1-b738-f14ae30fbfbd), [final verification](https://app.buildbuddy.io/invocation/a3e65743-df6a-47a3-afd3-12ba9133e266).

Round eleven verified that canceling Fork or declining the Rewind composer confirmation preserves the inline draft after Discard. The command queue test verified that a Send waits for a pending Swipe to apply its latest coalesced choice. All three regressions failed on `72e7e8dd`. BuildBuddy passed typecheck, 154 focused unit tests and 33 browser tests. Changed-file lint and `git diff --check` passed locally. [Baseline regressions](https://app.buildbuddy.io/invocation/5e14d4a9-79e0-4fae-8056-52f8b2344d1c) · [Passing run](https://app.buildbuddy.io/invocation/65d3ec89-942f-4c45-a675-63efae30b6be)


### Slice d

[PR #292](https://github.com/TanJeeSchuan/DitzyTavern/pull/292) carries the Generation owner and Swipe transaction changes.

- The Generation session owner holds the local request through preparation and acceptance. Acceptance installs the session keyed by Generation id in that same transition. The assembly controller reads that owner's start state; the pending-start reducer, acceptance handoff and retirement effect are deleted. Stream observations still go through the per-Variant store.
- Ordinary Swipe and Confirm Change use `requestVariantSelection` for the requested overlay, command queue and settlement. A queued ordinary Swipe revalidates even when the preceding command fails and stops if the writer has opened a Preview. It uses displayed history immediately when that history is already current. Confirm sends the approved Message and Variant at the queue's revision. The server validates those IDs even when the writer has opened another Preview or jumped to a different page.
- The controller no longer returns `stopGeneration` or `activeGenerationMessageIds`. Its old-visit Stop regression calls `cancelGeneration`. Leaving a Chat drops its visit's pending Stop flag as well as its stream cursor; the old response still cannot settle a replacement visit.

Focused coverage:

- `generation-session-runner.test.ts`: `a refresh that has not placed an accepted Generation cannot discard its stream` now drives the local request through acceptance before checking off-window streamed text. `a recovered active snapshot resumes the saved event cursor` and both `returning after an explicit/implicit Chat switch replays discarded text` cases cover cursor ownership.
- `generation-sessions.test.ts`: `reconnection attempts are bounded and re-armed by observed liveness` preserves the reconnect cap.
- `assembly-session.test.ts`: `acceptance subscribes while the story refresh is still in flight` uses the real owner and a fake stream transport. Existing acceptance, failure, retry and old-visit tests use the same owner.
- `conversation-session.test.ts`: `an old Stop mutation cannot settle a newer Stop after A to B to A` now visits a Chat without any Generation before returning, so it also rejects carrying the first visit's pending Stop into the second.
- `conversation-session.test.ts`: `a queued Swipe after a refused write uses current history while rendering is paused` checks that the queued Swipe and the following command can finish without animation frames when history is current.
- `useStoryMessageActions.test.ts`: `Confirm Change queued behind a Moves write uses its revision` covers the shared transaction's explicit historical selection. `opening an older Preview drops a queued ordinary Swipe` and `a failed preceding command leaves the queued Swipe blocked by Preview` cover the Preview guard after both preceding outcomes. `a new Preview stays open while an earlier Confirm Change persists`, `jumping to latest keeps a queued Confirm Change for an older Message` and `queued Confirm Change releases later commands while rendering is paused` verify that later navigation and rendering leave the confirmed command independent.

The queued Confirm and strengthened old-Stop probes fail with the corresponding baseline behavior restored. The six new Swipe and Preview regressions fail before their fixes and pass afterward. GitHub's Check workflow runs typecheck, full unit tests and the e2e suite. See the [PR checks](https://github.com/TanJeeSchuan/DitzyTavern/pull/292/checks).

The seeded browser on port 3100 accepted a Send, streamed its reply, switched Chats mid-stream, and replayed the reply on return. Explicit Stop preserved the partial reply. The browser also generated a sibling, persisted an ordinary Swipe, and confirmed an older Preview. Reload retained the confirmed Variant and later reply.

The [full Doherty run](https://app.buildbuddy.io/invocation/1539a059-40cd-42f5-a08b-765f283cc0a9) exposed failures under delayed APIs. Master reproduced those failures in the [core flows](https://app.buildbuddy.io/invocation/c06e4507-6b6d-4357-8b2e-2ed189ad411e), including long Chat paging, the Swipe browser and focus during source navigation, and in the [Race and World Clock flows](https://app.buildbuddy.io/invocation/1473f3be-08ab-41af-8e33-cacccb15c0bb).

The regular e2e run also hit an intermittent focus failure after selecting a tall Swipe. It reproduced on [master without API delay](https://app.buildbuddy.io/invocation/77181be0-9e65-4cda-9837-bec4ee7c49a3).
