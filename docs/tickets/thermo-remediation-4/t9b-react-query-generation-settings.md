# T9b — react-query for generation-settings draft; remove ref mirrors

Status: TODO

Blocked By: T9a

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

`src/client/workspace/useGenerationSettingsDraft.ts` (~10 counters), `src/client/workspace/prompt-preset/usePromptPresetEditorRuntime.ts` (~:68 mirror),
`src/client/workspace/useLorebookEditor.ts` (~:19 mirror), their tests and direct consumers.

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

- [ ] Migrate `useGenerationSettingsDraft`
- [ ] Remove the `stateRef.current = reduce(...)` mirror in `usePromptPresetEditorRuntime` and `useLorebookEditor` (use the reducer state / functional updates)
- [ ] typecheck, lint, `bun run test`; drive generation settings, prompt preset editor and lorebook editor in the app with playwright-cli
- [ ] Commit

## Acceptance

No request/version counter refs or ref mirrors remain in the three files.

## Outcome
