# T8: Client state

Status: READY

Blocked By: T7

Model: Sol 6.2 high writes and fixes slice a. Opus 5.5 high writes and fixes b and c, reviewed by `codex gpt-6.2-sol high`. Astra 6 high writes d; Sol 6.2 high fixes it.

**Slice c stops after the first write. The owner reads the new state model before fixes begin.**

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

Stop here after the first write and report: the overlay state's type, how the displayed Variant is chosen, and which effects were deleted.

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

- [ ] Slice a (Sol), PR
- [ ] Slice b (Astra), fixes (Sol), ADR 0036 amended, PR
- [ ] Slice c (Astra), report to the owner, then fixes (Sol), PR
- [ ] Slice d (Astra), fixes (Sol), PR

## Acceptance

`src/client/chat-info.ts`, `src/client/pending-generation-starts.ts`, `usePromptPresetLeave.ts` and `UnsavedBlockEditDialog.tsx` do not exist. `git grep -n -E 'ReadClaim|OperationClaim|pendingRetire|flushSync' -- src/client` is empty. Each guarantee listed above has a named test or e2e check in the Outcome. Typecheck, unit tests and e2e pass in CI on each slice.

## Outcome
