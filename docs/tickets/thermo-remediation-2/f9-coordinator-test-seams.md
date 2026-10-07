# Test-only seams threaded through production options

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F9.

## Goal

The Coordinator's stop path was testable only through two option-plumbed seams that no
production composition ever set: `GenerationConversationLifecycle` / `GenerationRuntimeLifecycle`
(copied shapes of the deep Conversation module and the real `GenerationRuntimeRegistry`) threaded
through `GenerationCoordinatorOptions` → `ConversationRouteOptions` → `AppOptions`, plus a
`ServerOwnedGenerationHandle` subset copy of `ServerOwnedGeneration`. Every production options
type carried two optional fields it never set, and one redundant `exists()` probe preceded
`getGenerationSettings()`. After this ticket the tests drive the real collaborators, the
production types carry no test fields, and nothing was introduced.

## Ownership

- `src/server/application/generation-coordinator.ts`
- `src/server/application/generation-coordinator.test.ts`
- `src/server/contract/stop-route-mapping.test.ts`
- `src/server/contract/conversation.ts` (`ConversationRouteOptions` declaration site, comment only)
- `src/server/app.ts` (`AppOptions` — no edit needed; the deleted fields fell out of the extends chain)

## Mechanics

- Deleted the interfaces `GenerationConversationLifecycle`, `GenerationRuntimeHandle`,
  `GenerationRuntimeLifecycle`, and the subset `ServerOwnedGenerationHandle`
  (`ManagedGenerationInput.start` now returns the real `ServerOwnedGeneration`).
- Deleted the `conversationLifecycle` / `runtimeLifecycle` option fields and the two private
  resolvers `conversationLifecycle()` / `runtimeLifecycle()`; `stopGeneration`,
  `stopAllGenerations`, and `coordinate` call `createConversationModule(database)` and
  `generationRuntimeFor(database)` directly.
- Dropped the redundant `exists()` probe in `coordinate` — the `undefined` check on
  `getGenerationSettings()` throws the same `ConversationNotFoundError` for the same inputs.
- `stop-route-mapping.test.ts` now drives the real routes against the real deep Conversation
  module (`acceptTailGeneration` / `acceptSiblingGeneration` / `resolveGeneration`) and the real
  `GenerationRuntimeRegistry` (`generationRuntimeFor(database).start`), the pattern the other
  runtime tests already use.
- `generation-coordinator.test.ts`'s fake-adapter section ("Stop lifecycle outcomes") was
  rewritten the same way; ordering is asserted through real effects instead of a fake call log:
  the runtime's `onStop` observes durable state (still Active for single Stop — abort precedes
  the durable commit; already empty for Stop All — durable commit precedes settlement).
- Judgment calls — three fake-driven settlement-failure scenarios were dropped rather than
  preserved in disguise, because the real `GenerationRuntime` cannot produce them:
  `stop()` / `markStopped()` only throw via `flushCheckpoint` → `onCheckpoint`, `publish()` is
  suppressed once `stopRequested`, and `flushAll` precedes settlement in Stop All (any pending
  checkpoint failure surfaces there first). Unreachable: single-Stop `unsettledReason`
  ("durable commit succeeds but the runtime cannot settle") and both Stop All `unsettled`
  scenarios. The `unsettled` outcome fields stay in the coordinator's contract — they are
  defensive production API, not test scaffolding.
- Also dropped: the fake test "natural completion wins the race" (subsumed by the real
  "terminal races" test, which exercises the same `releaseStopRequest` path via the deferred
  pending terminal), and the fake "Conversation is unknown with a live runtime" pair (a
  Conversation with an Active Generation cannot be deleted, so a live runtime over an unknown
  Conversation is unreachable; the `ConversationNotFoundError` mapping is still covered by the
  real unknown-Conversation Stop All test).

## Verification

- `bun run typecheck`, `bun run lint`, `bun run test`, `bun run check:contracts`,
  `bun run test:e2e` — all green.
- `rg 'GenerationConversationLifecycle|GenerationRuntimeLifecycle|ServerOwnedGenerationHandle' src/`
  → 0 matches; `rg 'conversationLifecycle\?|runtimeLifecycle\?' src/server/contract src/server/app.ts` → 0 matches.
- Longest production file < 1,000 lines.
