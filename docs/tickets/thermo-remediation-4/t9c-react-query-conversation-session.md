# T9c — react-query for useConversationSession

Status: DONE

Blocked By: T9b

Source: issue #52, finding **F10**. Read the whole finding first.

## Problem (shared across T9a–T9c)

Client "latest-wins" concurrency is hand-rolled ~40 times with `useRef(0)` request/version counters, plus three
`stateRef.current = reduce(...)` mirrors. `@tanstack/react-query` is already a dependency and used at 8 sites
(`AuthorNotePanel`, lorebook, memories, generation settings); it gives abort-on-refetch and latest-wins for free.

## Mechanics (shared)

- **Remove:** the hand-rolled counters / ref mirrors in the files this ticket owns.
- **Introduce:** `useQuery` / `useMutation` with `signal` for reads and `mutationKey`-scoped mutations for writes, following the existing react-query sites.
- **Behavior changed:** stale-response suppression becomes react-query's; in-flight requests are aborted on key change instead of ignored on return. Intended.
- The generation SSE session keeps its runner: it is a stream, not a request.

## Rejected

- A shared `useLatest()` helper: standardises the hand-rolled model instead of removing it.

## Files owned

`src/client/workspace/useConversationSession.ts` (~15 counters and the ~:39 `stateRef` mirror), `src/client/workspace/useStoryViewport.ts` (1 counter),
`src/client/workspace/useGenerationController.ts` (3 counters, only if they are request counters rather than SSE-session bookkeeping), their tests and direct consumers.

This is the riskiest hook in the client. Keep `useConversationSession.test.ts` behavior tests passing; rewrite their mechanics only where they drove the removed counters.

## Behavior constraints (acceptance)

Each must hold after the migration; state in the Outcome how each is guaranteed (test name, or code reference if untestable):

- **Latest wins:** switching the key (Conversation, preset, position) while a read is in flight never applies the older response.
- **Abort:** the superseded request is aborted through `signal`, not just ignored.
- **No duplicate fetch:** mount, StrictMode double-invoke, and re-render with the same key issue one request, not two.
- **No resurrection:** a mutation that resolves after its owner unmounted or after the key changed does not write into the new state.
- **Optimistic revision:** writes still send the current `expectedRevision`; a 409 conflict still adopts the server's current state exactly as before.
- **Cache freshness:** pick `staleTime` / invalidation so a write in one panel is visible in every other reader of the same key without a manual reload; no stale cache served after a write.
- **Cost:** request count does not scale with list size or render count.

## TODO

- [x] Map every counter in `useConversationSession` to the request it guards
- [x] Move the reads (conversation load, history pages) to `useQuery`; writes to mutations
- [x] Remove the `stateRef` mirror
- [x] `useStoryViewport` / `useGenerationController` counters
- [x] typecheck, lint, `bun run test`; drive open-conversation, switch-conversation, load-older-history and generate in the app with playwright-cli
- [x] Commit

## Acceptance

`grep -rnE 'Ref = useRef\((0|1)\)|VersionRef|requestIdRef' src/client | cut -d: -f1 | sort | uniq -c` shows none of the T9a–T9c files, except SSE-session bookkeeping justified in the Outcome.

## Outcome


**Removed:** the numeric navigation version; the synchronous Story reducer mirror; the local Conversation
state and its ref mirror. The navigation version guarded paging's anchor/follow-up read, source-jump reads
and render waits, refresh pages, and the latest-window read/render wait. All those reads now use keyed
queries and abort signals; Story remains owned by the existing reducer.

**Introduced:** `src/client/conversation-query.ts` with one shared summary key, revision-aware read
settlement and authoritative publication. Conversation/history reads consume query signals and defer
transport one microtask for StrictMode. History keys include the requested page/source position;
imperative reads fetch fresh data. Publication invalidates history without an unsolicited refetch.
Selecting a Chat invalidates its cached reads. Summary staleTime is infinite; history staleTime is
infinite only while its cached revision reaches shared Conversation authority, otherwise zero. History
settlement also retains a newer cached result for the same request key. Disabled reconnect refetch
preserves the current reading window. `useEffectEvent` reads committed Story state; `flushSync` dispatch commits
sequential page operations without a second reducer owner. Per-Conversation cancellation owns late
callbacks; a separate reading-window signal cancels multi-step navigation and its post-request scroll.
Stop/Stop All are keyed mutations whose captured owner signal guards settlement. The Conversation
session itself sends no writes: existing panel command runners retain their commands/revision semantics
and publish results through the session's owner-bound `setConversation` into that shared summary key.

**Behavior changed:** superseded HTTP reads abort rather than merely being ignored. Newer authority
cannot be rolled back by late summary/history reads; all summary readers see writes and conflicts.
A source jump cancels paging and refresh work, including a refresh still waiting on its summary read.
Detached refreshes preserve the entire loaded window. A stale page cannot silently satisfy a latest-window
jump or leave paging permanently busy. Late commands cannot publish through an unmounted/replaced
session, including A→B→A; late Stop results cannot settle a newer Stop with the same Generation id.

**Retained bookkeeping:** `useGenerationController.nextStartIdRef` identifies independently pending
Generation starts in the SSE runner's lifecycle; it is not a latest-request version. Replacing it with a
mutation key would collapse distinct starts, so it stays. `useStoryViewport.lastScrollTopRef` is a pixel
coordinate used to detect upward scrolling, not a request counter; the viewport is unchanged. The
public `activeChatIdRef` records selection synchronously for existing Generation/command consumers.
No reducer-state mirror or plain-request version counter remains in the owned hooks. The live baseline
had one navigation counter, one Generation-start identity counter, and one numeric viewport coordinate,
not the historical 15/3 request-counter counts in the issue.

**Behavior constraint evidence:** `src/client/workspace/conversation-session.test.ts` runs real hooks and
HTTP transport with deferred responses through the house `render-hook.ts` fixture:

- **Latest wins:** “switching Conversation aborts both open reads and rejects their late response” and
  “a newer source position aborts the old window and never scrolls to its late result”.
- **Abort:** both tests assert HTTP signal cancellation; “source navigation cancels a refresh still
  reading the Conversation before it can fetch history” and “a source jump supersedes paging without
  allowing the old completion to extend its window” cover the remaining multi-step paths.
- **No duplicate fetch:** “StrictMode, 21 summary readers, rerenders and reconnect issue one open pair
  and share writes” asserts exactly two initial GETs, independent of 21 readers and repeated renders.
- **No resurrection:** “a command settling after unmount cannot resurrect its Conversation owner”,
  its A→B→A counterpart, “an old Stop mutation cannot settle a newer Stop after A to B to A”, and
  “a Conversation switch during the render wait suppresses the old jump's scroll”.
- **Optimistic revision:** “commands use the current revision and a 409 publishes authority to every
  reader” submits revision 7, adopts server revision 9 in both readers, and retains the existing notice.
- **Cache freshness:** the shared-reader test also mounts a later reader; “publication aborts a late
  summary read and every reader retains the newer revision”, “a late refresh cannot roll back a newer
  write or its history”, and “reopening after a write and late refresh fetches fresh history and never displays the old
  cached page” reject stale authority and stale cache display.
- **Cost:** “paging follows the current edge and deduplicates rapid calls independently of window size”
  loads two older pages with two requests per page, ignores rapid duplicate calls, and adds no requests
  on rerenders. The 21-reader test covers summary cost.

Additional tests cover newer paging, detached multi-page refresh, jump-to-latest, and immediate cached
revision acquisition by `ensureLatest`. Every existing `useConversationSession.test.ts` behavior assertion
is intact; only its SSR-only mechanics were replaced with mounted QueryClient/HTTP mechanics.
The first key-switch test was run before migration and failed because both HTTP signals were un-aborted.
The extended reopen test then reproduced the late-read cache bug (expected three reads, got two); it
passes with revision-aware history freshness and prevents an obsolete result leaving reopen stuck loading.

**Review:** implementation skill's independent Luna Standards and Spec reviews: **0 findings each**.
A second round reviewed the history cache correction with the reproduced failure and its resolution:
**0 Standards findings / 0 Spec findings**.
Prior rejected approaches remain rejected: shared `useLatest`, value-based ABA matching, unguarded
hook-level mutation completions, independent authority snapshots, and backward-compatibility layers.

**Browser:** port 3000 was free. Started an owned Bun server and Vite. T3 preview opening explicitly
failed because AppArmor blocks its browser sandbox, so used the installed playwright-cli skill. Opened
and switched real Chats; a mocked one-Message history window loaded two older pages through the UI
(1→2→3 visible Messages). Mocked Generation acceptance plus terminal SSE displayed the completed
Message after history refresh (two history reads including initial open). No paid provider call or stored
Conversation mutation was made. Restored the browser preference, closed the named browser, deleted
its `.playwright-cli/` artifacts, and stopped only the two owned processes. Browser console contained
five existing Vite font 403s and no React warnings/errors.

**Verification:**

- `bun run typecheck`: final run exit 0. A transient concurrent T9b failure at
  `generation-settings-session.test.ts:153` (TS2502, self-referencing `profile`) was fixed by its owner.
- `bun run lint`: final run exit 0; **343 existing warnings / 0 errors**, none in owned code.
  A transient concurrent T9b missing-SAFETY assertion error was also fixed by its owner.
- `bun run check:contracts`: exit 0; **632 structural declarations, 151 schema derivations,
  11 existing suspicious cross-layer matches**.
- `bun test src/client`: **344 pass / 0 fail / 1186 assertions across 33 files**.
- `bun run test`: **1420 pass / 0 fail / 6006 assertions across 160 files**.
- Targeted session tests: **27 pass / 0 fail / 76 assertions across 2 files**.
- Owned-path `git diff --check`: clean. FFF confirms only the justified Generation-start identity and
  viewport coordinate remain among numeric refs; the session has only its public active-Chat pointer.

**Limits:** no e2e suite was run, as requested. Browser Generation/history were scripted; a real provider
Generation was not verified. Combined hook test runs emit React act warnings; the existing session test
file passes without them in isolation. Transient T9b failures were not edited by this ticket. Existing contract/font warnings remain.
