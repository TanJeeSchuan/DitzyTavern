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

## Acceptance

No request/version counter refs remain in either file.

## Outcome

**Before.** The grep matched `commandIdRef = useRef(0)` and the `editorVersionRef` mirror in
`useConnectionSettingsController.ts` (plus the reducer's `editorVersion`/`latestCommandId` fields and the
`command-started`/`commandId` action plumbing), and `nextAssemblyRequestIdRef = useRef(1)` in
`useAssemblyController.ts` (plus `issueAssemblyRequestId` / `invalidateAssemblyRequests` /
`isCurrentAssemblyRequest` / `canApplyAssemblyEffect`, `assemblyMountedRef`, `preparingRef`, the
`lastGenerationRef` state ref, and the whole `reduceAssemblySession` request-id reducer with its 9 actions).

**Removed.**
- `useConnectionSettingsController`: both counter refs; the `editorVersion`/`latestCommandId` reducer machinery
  (`editorChanged`, `ownsEditorResult`, `command-started`, the `commandId` guards on `set-error` /
  `command-conflict` / `apply-succeeded` / `delete-succeeded`); the `useAsyncEffect` load; the
  `loading`/`testPending`/`discoveryPending`/`saving` flag states; `runConnectionCommand`.
- `connection-settings-state`: `settings` and `presets` left the reducer (server data now lives in the query
  cache); `load-succeeded`/`load-failed` actions; the dead `credentialWasProvided` notice branch (it was
  hardcoded `false`).
- `useAssemblyController`: every `useRef`; the assembly request-id reducer and `assembly-session.test.ts`
  with it; the manual `dispatchAssembly` lifecycle.
- `assembly-session.ts`: `reduceAssemblySession`, `AssemblySessionAction`, `ownsRequest`; `AssemblySession` is
  now `{ phase, preview, error }`.

**Introduced.**
- `useConnectionSettingsController`: `useQuery` for `["connection-settings","settings"]` and
  `["connection-settings","presets"]` with `signal`; one `mutationKey`-scoped command mutation for
  create/apply/delete/reset, one for Test Connection, one for discovery. Results fold into the cache through
  `newerSettings`; the reducer receives editor/feedback actions. `sameEditorSnapshot` replaces the version
  counters: a command result adopts the server's Profile only while the submitted selection, draft, credential,
  and headers still match the editor that sent it. Stale conflicts (an `actualRevision` below the cached
  revision) are folded into the cache but not surfaced, matching the old guard.
- `useAssemblyController`: `useQuery` keyed by the assembly request (`skipToken` while closed) running
  `previewConversationGeneration(..., signal)`; plan edits go through `setQueryData`; two `mutationKey`-scoped
  start mutations (direct, acceptance) share one `issueGeneration`; `phase` is derived from
  `isFetching`/`isPending`/error. Cancel and conversation switch clear the request state and cancel the preview
  queries.
- `loadConnectionSettings`, `loadConnectionPresets`, `previewConversationGeneration` take an `AbortSignal` and
  pass `{ fetch: { signal } }`.

**Behavior changed.** Reads and the preview abort in flight on cancel/key change instead of being ignored on
return; stale suppression is react-query's. `applyDraft` returns whether the command applied instead of
"editor unchanged since submit"; the reducer still refuses to overwrite a newer draft (only the modal SaveGuard
path consumed the difference, and its dialog makes the editor unreachable while saving). Reset-credential
conflicts now fold the authoritative snapshot into the cache (feedback unchanged).

**Verification.**
- `grep -nE 'Ref = useRef\((0|1)\)|VersionRef|requestIdRef'` over both controllers: no match.
- `bun run typecheck` exit 0; `bun run lint` exit 0, no new warnings (the controller's two pre-existing
  >200-column lines remain); `bun run check:contracts` exit 0; `bun run test` 1357 pass / 0 fail; the two
  settings panels and the assembly panel driven in the dev app with playwright-cli (create/save/adopt profile,
  edit+save, test-connection failure outcome, discovery failure, delete, SaveGuard "Save and leave"; preview
  open/edit/refresh-discards-edit/cancel, mocked preview failure + Retry success, acceptance failure alert with
  the panel retained, direct-start failure toast). Only the expected HTTP-error console entries; no React
  errors. `.playwright-cli/` artifacts deleted.
- The dev server on port 3000 was stale (pre-T2) and returned 500 on the commands route; restarted from the
  current worktree for the browser check.

**Residuals.**
- A discovery refresh that completes after a concurrent Profile save still merges the pre-save profile snapshot
  into the cache; pre-existing race, unchanged and out of scope.
- The two pre-existing >200-column warnings in the controller stay for T12.
