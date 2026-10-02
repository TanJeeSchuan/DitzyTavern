# Complexity reduction opportunities

Initial review: 2026-09-30. Implementation status updated: 2026-10-02, for PR #9.

The original review recommended replacing duplicated client data/form bookkeeping and making the server's database lifetime explicit. PR #9 implements the server lifetime, SSE framing, and settings declaration changes, plus scoped Query and React Hook Form migrations. The remaining opportunities are broader client migrations and an unproven generation-session prototype.

The initial review was static; package searches used Exa and primary documentation. Implementation validation and its limitations are recorded in [complexity-reduction-handoff.md](complexity-reduction-handoff.md). Package evidence is in [complexity-reduction-packages.md](complexity-reduction-packages.md). File references below describe the PR implementation, without baseline line numbers.

## Recommendation status

| Original priority | Recommendation | PR #9 status | Remaining scope |
| --- | --- | --- | --- |
| 1 | TanStack Query for authoritative remote data | Partial: lorebook reads, memory polling, generation settings | Conversation/history coordination and other remote-data consumers |
| 2 | One explicit server application lifetime | Implemented | No omitted-database or per-generation connection path remains |
| 3 | React Hook Form for substantial editors | Pilot: generation settings | Connection settings and library editors |
| 4 | eventsource-parser for both SSE parsers | Implemented | Keep application event validation and activity policy |
| 5 | XState for the generation session interpreter | Deferred; no prototype or adoption | Prove a net simplification before migrating |
| 6 | Derive settings shapes and operations | Implemented | Preserve declarations that encode labels, limits, or changed meaning |

## Implemented server lifetime

- [server/index.ts](../../src/server/index.ts) opens one database and passes it to `createContract`, startup recovery, and the memory worker. Shutdown awaits memory work and generation cleanup before closing it.
- [contract/index.ts](../../src/server/contract/index.ts) requires the application database. [database/database.ts](../../src/server/database/database.ts) retains explicit opening and initialization; `withDatabase` and its owned/borrowed connection branches are gone.
- [generation-coordinator.ts](../../src/server/application/generation-coordinator.ts) uses its injected database for detached generations rather than acquiring and releasing a connection for each attempt.
- [generation-runtime.ts](../../src/server/workflows/generation-runtime.ts) keys runtime registries by database identity. Starts, subscriptions, stops, and shutdown share that registry; the process-wide default registry is gone.
- [generation-preview.ts](../../src/server/workflows/generation-preview.ts) keeps preview stores per database. Clearing a registry disposes only that database's store and is a no-op when no store exists.
- [generation-recovery.ts](../../src/server/workflows/generation-recovery.ts) flushes checkpoints, requests cancellation, terminalizes persisted rows, and then awaits the runtime drain. Detached tasks have a five-second grace period; state is released when they settle or the deadline expires.

Keep transactions synchronous and short. Provider calls run outside SQLite transactions. CLI entry points and tests open and close their own databases explicitly.

## Implemented client pilots

[useConversationMemories.ts](../../src/client/workspace/useConversationMemories.ts) uses Query for the memories, catch-up, and allowance reads, passes cancellation signals to transport, and polls while work remains active. [LorebookPanel.tsx](../../src/client/workspace/LorebookPanel.tsx) uses Query for library/detail, attachment, and selected-preset reads; writes cancel pending reads and update or invalidate caches.

[useGenerationSettingsDraft.ts](../../src/client/workspace/useGenerationSettingsDraft.ts) gives Query the authoritative settings and React Hook Form the local draft, dirty state, and resets. A shared reset helper establishes authoritative defaults and optionally restores the entire local draft. Refresh/conflict and save-completion paths use different preservation predicates: actual dirty state for refreshes, and a draft-version check for edits made during a save.

The pilot preserves the existing full-object command builder, fresh-base model selection, revision conflicts, and lexical parsing. Budget fields reject exponent and decimal text; blank sampling values mean `null`. A conflict preserves every local field rather than merging only dirty fields. Successful saves preserve edits made during the request, including reversions to an older default.

No resolver package was added. Wider form migration remains separate work.

Sources: [Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation), [Query defaults and polling](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults), [RHF form state](https://react-hook-form.com/docs/useform/formstate), [RHF reset](https://react-hook-form.com/docs/useform/reset).

## Implemented SSE and settings changes

[conversation-stream.ts](../../src/client/conversation-stream.ts) and [sse-activity.ts](../../src/server/model-client/sse-activity.ts) use `eventsource-parser` for framing, comment handling, and partial-frame assembly. The client retains payload schemas, target matching, numeric cursor checks, HTTP/network failure mapping, and terminal outcomes. The server retains its definition of meaningful provider activity. Arbitrary bytes do not automatically reset inactivity.

An unterminated final SSE event is ignored. A client stream ending without a terminal event reports interruption, allowing the session policy to handle reconnection.

[generation-settings.ts](../../src/shared/contract/generation-settings.ts) derives unchanged effective fields from the canonical TypeBox schema and replaces only fields with different effective semantics. [generation-settings-draft.ts](../../src/client/generation-settings-draft.ts) derives field types and conversions from declarations carrying labels and limits. Capture code no longer copies the effective settings through a field-by-field identity projection.

Source: [eventsource-parser](https://github.com/rexxars/eventsource-parser).

## Remaining opportunities

1. Extend Query to other remote-data consumers. [useConversationSession.ts](../../src/client/workspace/useConversationSession.ts) still coordinates conversation reads and paginated history manually. [usePromptPresetEditorRuntime.ts](../../src/client/workspace/prompt-preset/usePromptPresetEditorRuntime.ts) still owns read claims and stale-result decisions. Keep history and live generation content under one owner; Query cannot infer the ordering between stream events and older checkpoints. Evaluate `useInfiniteQuery` only with that reconciliation model defined.
2. Extend React Hook Form where it deletes substantial bookkeeping. Connection settings and lorebook editors retain custom draft and save/discard logic. Preserve credential/header keep, replace, and remove semantics, revision-conflict decisions, and whole-draft preservation. Do not add a generic form generator.
3. Prototype XState only for generation sessions. [generation-sessions.ts](../../src/client/generation-sessions.ts), [generation-session-runner.ts](../../src/client/generation-session-runner.ts), and [useGenerationController.ts](../../src/client/workspace/useGenerationController.ts) still implement transitions, ordered effects, observation controllers, disposal, and React wiring. Reject adoption if it only translates those actions into configuration without removing the interpreter.

An actor prototype must retain cursor monotonicity, identity checks, bounded reconnection, Stop races, and authoritative terminal refreshes. Stopping an observation actor detaches that client; only an explicit Stop command cancels the server-owned generation. Small reducers and importer merge/split logic do not automatically benefit from actors.

Sources: [Query infinite queries](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries), [XState invocation](https://stately.ai/docs/invoke), [callback cleanup](https://stately.ai/docs/callback-actors), [React integration](https://stately.ai/docs/xstate-react).

## Changes to avoid

- A framework rewrite or server-wide Effect adoption without a demonstrated deletion.
- Replacing the AI SDK, which already handles provider streaming.
- Replacing prompt macros with templates that still need custom nesting, escaping, scoped comments, and retained state.
- Adding Redis to avoid reasoning about memory source ownership, epochs, cancellation, and persistence.
- Generic repositories or file splits that leave generation capture, acceptance, checkpoint, and variant rules unchanged.
