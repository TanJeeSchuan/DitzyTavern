# Complexity reduction opportunities

Review date: 2026-09-30.

The largest opportunity is to delete the client machinery for managing remote data and form drafts. The strongest backend opportunity is to give the running application one explicit database and runtime lifetime. Splitting large files would leave these costs intact.

This was a static review of the main client loading, editing, generation and streaming paths, server application construction, generation preparation and persistence, and memory processing. Package searches used the direct Exa MCP, then primary documentation. No application changes or runtime verification were performed. Line counts below include comments and blank lines; they describe the affected code, not promised deletions.

## Ranked recommendations

| Priority | Change | Expected benefit | Confidence |
| --- | --- | --- | --- |
| 1 | Use TanStack Query for authoritative remote data | High, across many panels | High |
| 2 | Construct one explicit server application instance | High, removes alternate resource-lifetime paths | High |
| 3 | Use React Hook Form for substantial editors | High, across settings and library editors | High, after separating remote data |
| 4 | Replace both handwritten SSE parsers with eventsource-parser | Moderate, small and well-defined change | High |
| 5 | Replace the generation session interpreter with XState actors | Potentially high, net reduction needs a prototype | Medium |
| 6 | Derive settings shapes and field operations from existing declarations | Moderate, narrow refactor without another package | High |

## 1. Give remote data one owner with TanStack Query

Evidence:

- `src/client/workspace/LorebookPanel.tsx:98` starts a collection of view, library, match, attachment, preset, impact, export and draft-version refs. Its refresh and selection handlers repeatedly check request ownership before updating state.
- `src/client/workspace/useConversationMemories.ts:12` implements request generations, stale versus failed status, polling, and explicit replacement of cached collections.
- `src/client/workspace/useConversationSession.ts:45` manually coordinates the conversation read with paginated history and repeats that coordination during refresh.
- `src/client/workspace/prompt-preset/usePromptPresetEditorRuntime.ts:90` implements read claims and stale-result classification alongside editor operations.
- `src/client/lib/use-async.ts:28` supplies cancellation flags, but each consumer still writes its loading, success, error and cancellation branches. Searches found consumers in twelve client files outside the helper and its test.

Use `@tanstack/react-query` with resource keys such as `['lorebook', bookId]`, `['memories', conversationId]`, and `['conversation', conversationId]`. Replace read effects with queries, memory intervals with conditional `refetchInterval`, and successful writes with cache updates or invalidation. Use `useInfiniteQuery` for history after the simpler resource reads are migrated.

The deletion target is the remote-data portion of these controllers: copied server objects, loading flags, read counters, read cancellation flags and repeated refresh plumbing. Query data should be the authoritative client copy; keeping the same object in a reducer and synchronizing it from Query would add complexity.

Keep local drafts, preview selection, source-message navigation, revision-conflict decisions and generation event ordering explicit. History currently combines persisted pages with live variant content. Preserve one owner for that accumulated content when changing its data source. TanStack Query does not know how a newer stream event relates to an older database checkpoint.

Consume the query `AbortSignal` in the transport. Choose refetch and retry policies explicitly. A domain result such as `outcome: 'conflict'` remains an application outcome, not a successful save merely because its Promise resolved. Cache cancellation cannot undo a submitted command.

First migration: lorebook library/detail reads and memory polling. These demonstrate the benefit without changing generation semantics.

Sources: [query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation), [infinite queries](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries), [defaults and polling](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults).

## 2. Make database and runtime lifetime explicit

Evidence:

- `src/server/index.ts:11` opens a database for the memory worker and recovery, but serves the separately imported `contract`.
- `src/server/contract/index.ts:29` accepts an optional database; its exported singleton calls `createContract()` without one.
- `src/server/database/database.ts:68` implements owned versus borrowed connections, synchronous versus asynchronous results, and conditional closing.
- `src/server/application/generation-coordinator.ts:510` adds another acquire/release implementation for detached generations.
- `src/server/workflows/generation-runtime.ts:448` maintains both a default runtime registry and database-keyed registries.
- `src/server/memory/work.ts:5` keys running work by database object identity. A new connection to the same file is a different key.
- `src/server/workflows/generation-preview.ts:102` has process-global preview maps independent of the injected database.

Open the database once at startup. Construct the routes, generation coordinator, preview store and memory work tracking for that application instance. Require the database at the route/module construction seam. Pass the same generation registry to starts, subscriptions, stops and shutdown. Tests construct their own application with an in-memory database.

Remove the omitted-database path, `withDatabase` ownership logic, per-generation acquire/release, default-versus-injected registry selection and module-global preview storage. Command-line entry points can still open and close their own database explicitly. No dependency-injection framework is needed.

This also makes memory cancellation easier to reason about: HTTP mutations and the worker address the same running-work owner. The current identity split is visible in code; its user-visible consequences were not tested in this review.

Keep transactions synchronous and short. Do not hold SQLite transactions across provider calls. Changing only `createContract(database)` is incomplete because graceful shutdown currently defaults to the other runtime registry. The entire lifetime choice should change together.

## 3. Replace custom form bookkeeping with React Hook Form

Affected code includes the 382-line connection controller plus its 277-line state reducer, the 366-line generation-settings hook plus its 368-line draft helper, and the 688-line lorebook panel. These files also contain domain and rendering code that remains necessary.

The connection controller compares serialized drafts and headers with their saved equivalents. The generation editor keeps separate state and setters for instruction, strategy, suffix, sampling, budget and overrides. Lorebooks implement another dirty/save/discard scheme.

Use `react-hook-form` for form values, dirty fields, validation errors, submission state and reset. Use `Controller` for Radix controls and `useFieldArray` where editable rows need insertion, removal or movement. `@hookform/resolvers/typebox` supports the already installed `@sinclair/typebox`; changing schema libraries is unnecessary.

Keep resource loading in Query and the editable draft in the form. Delete the superseded field-setter actions, manual dirty comparisons and reset fan-out. Preserve the command payload builder where it expresses real semantics, especially credential/header keep, replace and remove operations.

Two behavior constraints matter:

- A conflict currently preserves the entire local draft. `reset(serverValues, { keepDirtyValues: true })` changes untouched fields and is therefore not an equivalent implementation. On conflict, preserve the draft and show the authoritative state separately.
- Generation budget fields reject exponent and decimal text and sampling blanks mean `null`. Keep explicit lexical conversion at the form seam; `valueAsNumber` alone does not encode those rules. Successful saves must also avoid discarding edits made while the request was in flight.

First migration: generation settings after its remote read is moved to Query. Use its existing behavior checks and manual UI inspection, without adding UI tests.

Sources: [form state](https://react-hook-form.com/docs/useform/formstate), [reset behavior](https://react-hook-form.com/docs/useform/reset), [TypeBox resolver](https://github.com/react-hook-form/resolvers#typebox).

## 4. Delete both handwritten SSE framing implementations

`src/client/conversation-stream.ts` has 228 lines and `src/server/model-client/sse-activity.ts` has 105. Both accumulate decoded text, split frames, split lines and collect data fields.

Use `eventsource-parser` for framing. The browser can pipe through `TextDecoderStream` and `EventSourceParserStream`; the server can feed a parser while forwarding the original bytes, using `onComment` for keep-alive observations.

Delete manual frame and data-line assembly. Keep payload schemas, target matching, numeric cursor checks, terminal outcomes, and the server's definition of meaningful activity. The parser handles the protocol, not these product rules. An arbitrary provider chunk must not automatically reset inactivity under the current policy.

Audit EOF and malformed-frame behavior against the existing stream tests: the current browser consumer processes trailing pending text even without a complete SSE delimiter, whereas a standards-based parser may not dispatch that as an event. Adopt one defined protocol behavior and remove the old parser.

This is the cheapest confident package replacement. A complete reconnecting EventSource client would overlap with the existing session machine; a parser is the narrower fit.

Source: [eventsource-parser](https://github.com/rexxars/eventsource-parser).

## 5. Evaluate XState for the custom session interpreter

`src/client/generation-sessions.ts` has 609 lines, `generation-session-runner.ts` has 165, and `workspace/useGenerationController.ts` has 355. Together they define transitions, ordered effects, an effect interpreter, controller and listener collections, disposal, snapshot subscriptions and React wiring.

Use `xstate` and `@xstate/react` to represent each observed generation as an actor. Its observing state invokes the subscription; exiting that state aborts the local read. A parent owns the dynamic set of generation actors. React reads actor selectors instead of a hand-built external store.

The strongest deletion target is the runner and its generic subscription bookkeeping. Cursor monotonicity, identity checks, bounded reconnection, Stop races and authoritative terminal refreshes remain application rules.

Prototype this only for generation sessions. Do not convert every reducer: the small assembly reducer and the importer's merge/split logic do not automatically become simpler in XState. Reject the migration if it merely rewrites every existing action and effect as machine configuration. Net line savings are unproven.

Stopping an actor must detach observation, not cancel the server-owned generation. Only an explicit Stop command cancels that generation. Callback actor errors also need deliberate reporting to the parent.

Sources: [invocation lifecycle](https://stately.ai/docs/invoke), [callback cleanup](https://stately.ai/docs/callback-actors), [React integration](https://stately.ai/docs/xstate-react).

## 6. Stop restating the settings vocabulary

`src/shared/contract/generation-settings.ts` declares the canonical schema and then repeats most fields in `effectiveGenerationSettings`. `src/client/generation-settings-draft.ts` repeats sampling and budget keys in unions, arrays, interfaces, empty constructors, converters and resolvers. `src/server/workflows/generate-capture.ts:719` copies effective settings field by field.

Derive the unchanged effective fields with TypeBox `Pick` or `Omit`, then replace only the intent-sensitive fields and request-overrides shape. Derive draft/value types with `Record` and `Pick`. Use the existing label and minimum declarations where they encode actual per-field information, and perform repeated conversions over those keys.

Check whether the effective-settings object itself can satisfy the persisted JSON type. If it can, remove the identity projection rather than maintaining another list of every field. Keep projections that intentionally omit secrets or change meaning.

This is a local refactor, not a reason to build a generic form generator or add a utility library. It overlaps with the form migration; count the deletions once.

## Changes I would avoid

- A framework rewrite or an Effect adoption across the server. Neither targets a demonstrated deletion here.
- Replacing the AI SDK: it already handles provider streaming. The remaining capture, acceptance, checkpoint and variant rules belong to this application.
- Replacing prompt macros with Handlebars or Liquid. Nested syntax, escaping, scoped comments and retained macro state would still require custom behavior.
- Adding a Redis queue for the memory worker. The short polling loop is not the hard part; source ownership, work epochs, cancellation and collection persistence are.
- Adding generic repositories or splitting `generate-capture.ts` merely because it is large. Preserve its snapshot-before-await rule and transactional acceptance rechecks.

## Suggested order

1. Replace SSE framing for a small, bounded deletion.
2. Move lorebook reads and memory polling to Query, then use the same pattern across remote-data consumers.
3. Migrate substantial forms and remove their old field bookkeeping.
4. Unify server application lifetime as one coordinated refactor, including shutdown.
5. Consolidate settings declarations while touching those modules.
6. Prototype XState last and retain it only if the interpreter disappears and the remaining lifecycle is easier to follow.

Package evidence and limitations are recorded separately in [complexity-reduction-packages.md](complexity-reduction-packages.md).
