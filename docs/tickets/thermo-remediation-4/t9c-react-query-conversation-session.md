# T9c — react-query for useConversationSession

Status: TODO

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

## TODO

- [ ] Map every counter in `useConversationSession` to the request it guards
- [ ] Move the reads (conversation load, history pages) to `useQuery`; writes to mutations
- [ ] Remove the `stateRef` mirror
- [ ] `useStoryViewport` / `useGenerationController` counters
- [ ] typecheck, lint, `bun run test`; drive open-conversation, switch-conversation, load-older-history and generate in the app with playwright-cli
- [ ] Commit

## Acceptance

`grep -rnE 'Ref = useRef\((0|1)\)|VersionRef|requestIdRef' src/client | cut -d: -f1 | sort | uniq -c` shows none of the T9a–T9c files, except SSE-session bookkeeping justified in the Outcome.

## Outcome
