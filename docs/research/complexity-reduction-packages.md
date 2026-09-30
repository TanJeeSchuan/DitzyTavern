# Package fit for reducing client complexity

This note checks whether four package choices can replace existing DitzyTavern code. It uses the current code shape described for this review: React 19, Bun 1.3, Elysia/TypeBox 0.34; request cancellation flags, form draft conflict handling, two SSE parsers, and a generation-session reducer plus runner.

## TanStack Query (`@tanstack/react-query`)

**Fit:** Good for server state such as lorebook requests and memory polling. Query functions receive an `AbortSignal`; passing it to `fetch` lets Query abort transport when a query becomes obsolete. Query keys, caching, refetch policy and observer lifecycle can replace repeated request state and polling orchestration.

**Replacement boundary:** Replace per-view fetch/loading/error state and polling timers where the data is a query. Continue to own draft editing, conflict decisions, and ordered generation-event processing. Query caching does not define whether a conflicting server update replaces or preserves an entire local draft.

**Caveat:** Unused queries are not cancelled by default; the query function must consume and forward `signal` for the underlying request to stop. Cancellation reverts query state. The docs also note cancellation does not work with the Suspense query hooks. This package is a state/cache layer, not a generic cure for every `useAsyncEffect`.

Source: [TanStack Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation).

## React Hook Form + TypeBox resolver

**Fit:** `@hookform/resolvers/typebox` can validate a form with TypeBox and infer values from the schema. Resolver docs cover both TypeBox `ValueCheck` and compiled `TypeCompiler`, and explicitly support installing the resolver with Bun. The resolver package metadata lists `@sinclair/typebox >=0.25.24` and `react-hook-form ^7.55.0` as peers, so TypeBox 0.34 meets the stated range; verify the installed RHF version against the peer range before adopting.

**Replacement boundary:** RHF can replace hand-maintained field registration, validation errors and JSON-stringify dirty checks for ordinary forms. Its `reset(values, { keepDirtyValues: true })` updates non-dirty fields while retaining dirty fields. That is a field-level merge, and therefore does **not** preserve the whole draft unchanged when a remote conflict arrives. Keep the existing whole-draft conflict policy explicit; do not map it to `keepDirtyValues` and assume equivalent behavior.

**Caveat:** `keepDirtyValues` requires subscribing to `dirtyFields`; reset values should include complete defaults, and supplying reset values changes the form's defaults unless `keepDefaultValues` is set. If schemas include Elysia-specific custom TypeBox kinds, the resolver README says their `Kind`/formats must be registered with TypeBox's `TypeRegistry`/`FormatRegistry` on the same TypeBox module instance used to build the schema. Elysia-generated schemas should be checked for such custom kinds.

Sources: [RHF reset API](https://react-hook-form.com/docs/useform/reset), [resolver TypeBox docs](https://github.com/react-hook-form/resolvers#typebox), [resolver package metadata](https://registry.npmjs.org/%40hookform%2Fresolvers).

## `eventsource-parser`

**Fit:** Appropriate for the duplicated browser/server SSE frame parsing. It is source-agnostic: feed decoded chunks and receive complete EventSource messages, including handling partial frames split across chunks. Its current README documents browser/Node/Deno use and a TransformStream variant; the registry listing identifies the package as a zero-runtime-dependency parser. Bun is not explicitly named as a parser runtime in the README, though Bun's JavaScript runtime and standard stream APIs make a small integration check prudent.

**Replacement boundary:** Replace only frame boundaries and field decoding. Keep DitzyTavern's target/cursor checks, payload schema validation, and server-side activity classification in the consumers; the parser knows the SSE format, not application event meaning or authorization.

**Caveat:** This is not an EventSource client or transport. The caller still reads the stream and decides reconnection, cancellation and error policy. Call `reset()` before reusing a parser, and use `reset({ consume: true })` at stream end when pending input should be consumed. Unknown fields surface through `onError` unless handled by policy.

Source: [eventsource-parser README](https://github.com/rexxars/eventsource-parser).

## XState + `@xstate/react`

**Fit:** XState can encode explicit states, transitions, guards and actor orchestration for the generation-session lifecycle. `@xstate/react` provides hooks that create/start an actor for a component lifetime and stop it on unmount; `useSelector` allows selective subscriptions. Both packages document Bun installation, and the React package declares XState as a peer dependency.

**Replacement boundary:** A machine could replace reducer transition logic and make legal lifecycle transitions explicit. Effects still need to be implemented as actors/services, and React unmount cleanup must stop the **local subscription/controller** only. It must not accidentally cancel the server generation, which can outlive a view. Preserve the runner's event ordering, reconnect behavior and ownership rules in the machine's transition/actions design.

**Caveat:** XState's lifecycle hooks manage local actors, not application-level cancellation semantics. The existing reducer has 609 lines and its runner has 165, including comments and blank lines. No source evidence establishes that a machine would reduce total code, since machine declarations, actors and adapters may offset reducer removal. Prototype one lifecycle slice and compare total production code before committing to a migration.

Sources: [XState overview](https://stately.ai/docs/xstate), [XState React API](https://stately.ai/docs/xstate-react).

## Recommendation

The strongest low-risk candidates are Query for server-state reads/polling, RHF + resolver for form mechanics (while retaining conflict policy), and `eventsource-parser` for shared wire-format framing. XState is a modeling option for the generation lifecycle, but its net complexity benefit is unproven and requires a bounded prototype before replacing the reducer/runner.

## Manifest check

The npm registry returned these versions on 2026-09-30. These are metadata checks, not installed or runtime-tested dependencies.

| Package | Version | Relevant declared constraint |
| --- | --- | --- |
| `@tanstack/react-query` | 5.104.0 | React 18 or 19 |
| `react-hook-form` | 7.89.0 | Includes React 19; Node >=18 |
| `@hookform/resolvers` | 5.9.1 | RHF ^7.55.0; TypeBox >=0.25.24 |
| `@xstate/react` | 6.1.0 | Includes React 19; XState ^5.28.0 |
| `eventsource-parser` | 4.1.1 | Node >=22.12 |

React and TypeBox declarations fit this repository. The parser's Node engine declaration does not establish Bun compatibility; check the selected version under the project's Bun runtime before adopting it.

Sources: [Query metadata](https://registry.npmjs.org/@tanstack/react-query/latest), [RHF metadata](https://registry.npmjs.org/react-hook-form/latest), [resolver metadata](https://registry.npmjs.org/@hookform/resolvers/latest), [XState React metadata](https://registry.npmjs.org/@xstate/react/latest), [parser metadata](https://registry.npmjs.org/eventsource-parser/latest).
