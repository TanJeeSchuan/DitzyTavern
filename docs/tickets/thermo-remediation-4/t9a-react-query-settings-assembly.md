# T9a — react-query for connection settings and assembly controllers

Status: DONE

Blocked By: T7, T8

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

`src/client/workspace/useConnectionSettingsController.ts` (~6 counters), `src/client/workspace/useAssemblyController.ts` (~5 counters), their tests and direct consumers.

## TODO

- [x] Count counters before: `grep -nE 'Ref = useRef\((0|1)\)|VersionRef|requestIdRef' <file>`
- [x] Migrate `useConnectionSettingsController`
- [x] Migrate `useAssemblyController`
- [x] typecheck, lint, `bun run test`; drive the connection-settings and assembly panels in the app with playwright-cli
- [x] Commit

## Review fix round 1

- [x] Retain editable previews across reconnects; explicit Refresh still replaces the plan.
- [x] Reject save results after A→B→A editor changes.
- [x] Cancel session ownership on switch/unmount; reject every late mutation effect.
- [x] Prevent late settings reads from rolling back authoritative writes.
- [x] Share the connection query across all readers and publish all writes/conflicts.
- [x] Restore lifecycle/conflict/deletion behavior tests; run required checks and commit.

## Acceptance

No request/version counter refs remain in either file.

## Outcome

Initial implementation: `23c211e`. Review fix round 1 replaces its serialized editor matching and closes
its reconnect, session-ownership, and settings-cache races. No request/version counter refs remain.

**Removed:** `sameEditorSnapshot` and its serialized field comparisons; conversation-id-only mutation
ownership; independent Connection Settings state and fetches in ModelSelector, ProfileModelPicker, Memory,
and Semantic Trigger settings; the pickers' `settings`/`onSettingsChange` props and their forwarding.

**Introduced:** a reducer-owned immutable `editorIdentity` replaced on edit/selection/discard; a session
AbortController captured by every Generation submission and aborted on switch/unmount; a synchronous
one-shot start gate; `connection-settings-query.ts` with one shared key, read options, and authoritative
publication that cancels pending reads before folding revisions into the cache. Settings and presets defer
transport to the next microtask so StrictMode's superseded subscription aborts before making a request.
Discovery uses its `settingsRevision` when merging a returned Profile, rejecting older results.

**Behavior changed:** reconnect cannot replace an edited preview; only explicit Refresh reassembles it.
Reopening a closed preview fetches a fresh plan. Returning an editor from A to B to A cannot adopt an old
save, clear its credential draft, or report success. Late Generation completions cannot close a new panel,
clear its draft, or report acceptance. Reads cannot roll back saved settings, including text-only writes that
keep the same revision. Every connection reader sees writes and conflicts without reloading.
Memory Settings and Semantic Trigger Settings are different resources: their own drafts/reads remain;
only their independent reads of the Connection Settings resource were removed.

**Behavior constraints and evidence:**

- **Latest wins:** `assembly-session.test.ts` — “conversation switch closes the preview and rejects the
  older read”; Connection controller test — “a late settings read cannot roll back a successful save”.
  `connection-settings-state.test.ts` — “a save result cannot adopt after editing A to B and back to A”.
- **Abort:** assembly cancel/switch tests assert the HTTP signal is aborted. “a settings request aborts
  when its last reader unmounts” also rejects a late response. Generation transport accepts the submission
  signal for send/continuation/sibling; `issueGeneration` checks it before/after `ensureLatest` and after HTTP.
- **No duplicate fetch:** “StrictMode mount and repeated readers share one settings request and all see
  writes” and “StrictMode and rerenders issue one settings read and one presets read”. Assembly uses one
  request-keyed query; “an edited plan survives reconnect; explicit Refresh replaces it” asserts one read
  through edits/reconnect and exactly one additional read for explicit Refresh.
- **No resurrection:** assembly tests cover acceptance after unmount, A→B→A, switching while waiting for
  latest, switching during `refreshStory`, and preparation resolving after unmount. `finishStart` and both
  mutation error callbacks check the captured session signal; completion after story refresh checks it again.
  Editor identity rejects save adoption into a later selection/draft; cache authority remains shared server data.
- **Optimistic revision / 409 adoption:** Connection hook tests “a conflict adopts authority for every
  reader while retaining the edited Profile” and “deletion adopts authority for every reader and clears
  pending deletion” restore the lost assertions. They check command bodies, revisions, cache authority,
  retained draft/credential, and deletion feedback. Assembly success checks submitted `expectedRevision`.
- **Cache freshness:** all readers call `useConnectionSettingsQuery`; profile commands, pin commands,
  text-only writes (including GenerationErrorToast), and conflict results call `publishConnectionSettings`.
  Discovery cancels reads before its revision-aware cache update. “a late read cannot undo a text-only write
  at the same revision” covers the resource's non-revision-bumping write. Infinite staleTime avoids a second
  fetch on panel mounts; successful writes directly notify every observer.
- **Cost:** the shared-read test mounts 21 simultaneous readers, rerenders, then mounts another reader
  after publication: one HTTP read throughout. Neither query has a per-Profile request.

**Restored assembly coverage:** stale-response rejection; edited-plan retention through acceptance failure
and retry; one-shot acceptance (two calls in one render); closure on success, cancel, and Conversation
switch. Additional tests cover fresh reopen, reconnect retention, and the session cancellation races above.
Targeted behavior tests: **28 pass / 0 fail / 116 assertions across 3 files**.

**Regression verification against `23c211e`:** a temporary source archive (no worktree or install) ran the
new ABA reducer test, acceptance-after-unmount hook test, and late-settings-read hook test. Each failed
for the reported behavior: “Local edit” became “Saved”; clear/refresh/accepted fired after unmount;
revision 3 became 2. The temporary archive was removed. All three pass with the fixes.

**Required verification:**

- `bun run typecheck`: exit 0.
- `bun run lint`: exit 0; **343 existing warnings, 0 errors**; no new warnings in changed code.
- `bun run check:contracts`: exit 0; **631 structural declarations, 151 schema derivations,
  11 existing suspicious cross-layer matches**.
- `bun test src/client`: **301 pass / 0 fail / 1038 assertions, 30 files**.
- `bun run test`: **1377 pass / 0 fail / 5858 assertions, 157 files**.
- Code-review skill: independent Luna Standards and Spec reviewers, **0 findings on each axis**.

**Browser:** port 3000 was free; started owned server/Vite processes. T3 preview opening was unavailable
because AppArmor blocked its browser sandbox, so the installed playwright-cli was used. Created/saved a
temporary Profile; the composer picker saw it without reload; pin and text-only changes reached Memory's
picker and the Connection list; opened Semantic Trigger settings. Mocked assembly preview/start responses
verified edited-plan retention after offline/online events and two failed acceptance requests, explicit Refresh
(two preview reads total), and Cancel preserving the draft. Deleted the temporary Profile, closed the named
browser, removed `.playwright-cli/`, and stopped only the two owned servers. Browser console contained
five pre-existing Vite font 403s and two intentional mocked HTTP 422s; no React errors.

**Limits:** no e2e suite was run, as requested. Generation success is covered with the real hook/transport
and scripted HTTP response; no paid provider generation was attempted. The existing contract-audit matches
and lint warnings were not changed.
