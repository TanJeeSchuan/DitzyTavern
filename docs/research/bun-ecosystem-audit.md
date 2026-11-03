# Bun ecosystem fit for DitzyTavern

Audited on 2026-10-22 at `52b9c25c`, with Bun 1.4.4. Companion to the [complete 1.4.4 feature audit](bun-1.4.4-feature-audit.md).

Scope: every capability family in Bun's [official documentation catalog](https://bun.com/docs/llms.txt), plus adjacent frameworks, database/search extensions, AI integrations, authentication, jobs, observability, and deployment tools relevant to this checkout. The npm ecosystem is open-ended; this is a repository fit audit, not a claim to have examined every compatible package. Live documentation can describe APIs beyond an installed release. Local probes below distinguish availability from documentation and from application correctness.

## Judgment

The repo already uses the important Bun integrations: Elysia/Eden, Drizzle over `bun:sqlite`, Bun's test runner, native file responses, and AI SDK provider streaming. There is no clear benefit to replacing the stack with another Bun-compatible framework.

The largest new opportunity is **SQLite-side Memory ranking**, if a representative workload shows the current vector decode/score/sort work matters. The cleanest small native-API opportunity is **`Bun.ArrayBufferSink`**. Elysia's **built-in SSE helper** and AI SDK's **embedding APIs** deserve bounded investigation, but neither automatically removes the domain machinery around them. Profiling is useful before undertaking any performance migration.

The previous audit's formatter, combined dev command, cache reuse, one-shot SHA-256, and Bun declaration updates remain the most actionable general improvements. They are not new findings from widening the scope.

## Concrete opportunities

### 1. Use a native accumulator inside the bounded response reader

[`readBoundedResponse`](../../src/server/model-client/model-fetch.ts) collects chunks and calls a handwritten `joinBytes` helper. [`Bun.ArrayBufferSink`](https://bun.com/docs/runtime/streams) can accumulate bytes and return a `Uint8Array`.

- **Removed:** the chunk array and final allocation/copy helper.
- **Introduced:** one sink configured with `asUint8Array: true`, with each write sliced to the remaining allowance.
- **Behavior changed:** none intended. Retain the byte cap, truncated-prefix result, early stream cancellation, abort race, and reader cleanup. A sink's `highWaterMark` is an allocation setting, not a response-size limit.
- **Evidence:** locally verified writes, typed-array subarray handling, and final byte output. No replacement was implemented or benchmarked.

This is a small cleanup. Replacing the whole function with `Bun.readableStreamToJSON` or `readableStreamToBytes` would discard requirements that the current loop implements.

### 2. Benchmark `sqlite-vec` against Memory's actual retrieval path

[`evaluateMemoryRecallSnapshot`](../../src/boxes/memory/server-recall.ts) embeds/cache-loads every eligible claim, scores every vector in JavaScript, sorts with an identity tie-break, and keeps 48 semantic candidates. [`readCachedVectors`](../../src/server/box/embedding.ts) decodes cached Float32 blobs into JavaScript number arrays before that work.

[`sqlite-vec`](https://alexgarcia.xyz/sqlite-vec/js.html) explicitly supports loading into `bun:sqlite`. Its Float32 representation matches the cache's storage format. A SQL distance query over eligible cached rows is a smaller first experiment than introducing a vector service or an indexed virtual-table lifecycle.

- **Removed if successful:** decoding every cached vector into JS, JS cosine scoring, and the full JS sort for the semantic shortlist. Candidate records and the recent-memory merge still exist.
- **Introduced:** a native extension, eligible-candidate SQL, and distribution/loading checks. A `vec0` index would add its own schema and maintenance; it is a separate decision.
- **Behavior changed:** computation moves into SQLite. Keep eligibility filtering before top-k, embedding-space isolation, current dynamic dimension checks, the deterministic identity tie-break, the recent shortlist, and Decision Model judging. Match the current `localeCompare` tie order deliberately; SQLite's binary collation is not automatically equivalent. Convert cosine distance to similarity deliberately. Compare rounding and zero-vector behavior; cached Float32 and freshly returned number vectors can differ numerically.
- **Evidence:** official Bun integration; current code/storage inspected. The extension was not installed, loaded, or benchmarked here.

Measure warm-cache retrieval separately from embedding HTTP calls. Compare the complete shortlist and boundary ties as well as elapsed time and allocation at representative claim counts. If provider latency dominates and local work is negligible, keep the current path. SQLite-side scanning still performs distance work; this is not evidence of sublinear search. The native driver is synchronous, so also measure request responsiveness under concurrent streaming traffic.

The packaging cost matters: Bun's SQLite docs and sqlite-vec's guide note that macOS may require a custom SQLite library before opening any connection. Validate supported Linux architectures and Windows too. A new native dependency needs a benefit large enough to pay for that.

### 3. Let Elysia own SSE framing where it reduces total code

Installed Elysia exports [`sse`](https://elysiajs.com/essential/handler.md). A local route probe produced an `id`, named event, JSON data, and `text/event-stream` response correctly. No stream plugin is needed.

The candidates are [`generation-sse.ts`](../../src/server/contract/generation-sse.ts) and the [update subscription](../../src/server/contract/updates.ts). They manually encode SSE frames and construct streaming responses.

- **Removed:** handwritten event/id/data framing and some response setup if the route returns a generator.
- **Introduced:** a generator adapter for callback subscriptions, potentially including an event queue and wakeup mechanism.
- **Behavior changed:** Elysia owns wire framing and generator streaming. Generation replay, event IDs, terminal frames, synchronous completion during subscribe, disconnect cleanup, and update comment heartbeats must retain their contracts. Existing cache-control requirements also remain.
- **Evidence:** framing/header probe passes on installed Elysia. Documentation describes automatic generator cancellation; the application's callback cleanup and replay races were not migrated or tested.

Start with the smaller update subscription and compare the resulting code. If the callback-to-generator adapter costs more than the framing it deletes, keep the current stream. Do not build a general event framework for this. The older `@elysiajs/stream` package is in maintenance mode; installing it would be the wrong direction.

### 4. Use more of the already-installed AI SDK only where semantics agree

Chat already uses [`streamText`](../../src/server/model-client/chat-completions.ts), with provider adapters, injected fetch, request overrides, cancellation, and diagnostic handling. Recommending AI SDK as a new integration would miss the existing design.

Two smaller gaps remain in [`embeddings.ts`](../../src/server/model-client/embeddings.ts):

| Candidate | Machinery removed / introduced | Behavior and decision |
| --- | --- | --- |
| `ai.cosineSimilarity` | Removes the local cosine implementation; introduces an import from an existing dependency. | Local probes found a rounding difference for identical vectors and an exception for unequal dimensions, where the current helper returns zero. Memory checks dimensions before scoring, but the helper is also exported through the Box SDK. Adopt only with an intentional contract decision; do not add a wrapper solely to reproduce every old branch. |
| `embedMany` | Could replace request construction and provide provider-aware batch splitting/concurrency. Introduces an embedding provider instance and SDK error mapping. | Current `embedTexts` sends all missing texts in one request. SDK batching is useful if provider input limits are a real problem. Preserve exact configured endpoints, credentials/custom headers, injected fetch, redirects policy, bounded response consumption, deadlines, and failure categories. SDK retries default to two: use an explicit policy, consistent with the chat path's zero retries. Domain caching and embedding-space identity remain. |

Sources: [cosine similarity](https://ai-sdk.dev/docs/reference/ai-sdk-core/cosine-similarity), [embedMany](https://ai-sdk.dev/docs/reference/ai-sdk-core/embed-many), and [OpenAI-compatible provider configuration](https://ai-sdk.dev/providers/openai-compatible-providers). The documented current batch limits/options need checking against the installed provider implementation before adoption. No embedding transport migration was tested.

### 5. Use Bun's profiler before choosing a performance rewrite

The [profiler/debugger](https://bun.com/docs/runtime/debugger) and [benchmarking guidance](https://bun.com/docs/project/benchmarking) are useful for prompt assembly, Memory ranking, lore scanning, and imports. CPU profiles can separate local computation from time spent waiting on providers. Markdown CPU profiles are also available in the documented tooling.

- **Removed:** guesswork when choosing between a faster algorithm, a native API, and leaving the code alone.
- **Introduced:** an on-demand profiling command and a representative workload. No logging service or production instrumentation is required.
- **Behavior changed:** diagnostic overhead during the run; no intended product behavior change.
- **Evidence:** inspected candidate paths and local `bun --help`, which exposes `--cpu-prof`, `--cpu-prof-md`, `--heap-prof`, and `--heap-prof-md`. No representative performance profile or application speedup was measured in this audit.

### 6. Trial Vite under Bun independently of replacing Vite

Bun's [Vite guide](https://bun.com/docs/guides/ecosystem/vite) explicitly documents `bunx --bun vite`, because a Node shebang otherwise selects Node. The installed CLI starts with `bunx --no-install --bun vite --version` and reports Vite 8.3.4 with Bun's runtime marker.

- **Removed:** Node execution for the Vite CLI if the trial succeeds.
- **Introduced:** an explicit runtime selector in dev/build commands.
- **Behavior changed:** Vite and its plugins execute on Bun. React, Tailwind, import maps, host chunks, and Box client builds remain Vite responsibilities.
- **Evidence:** CLI startup only. Full production build, development HMR, and Box loading were not verified under the changed CLI runtime.

This does not establish a speedup or remove the repository's Node requirement. Node still runs the custom lint-rule tests, E2E harness tests, and screenshot tooling. The harness uses Node-specific test mocking and process behavior. Avoid a blanket runner migration.

## Product opportunities, not missing cleanup

| Addition | Fit and structural cost |
| --- | --- |
| SQLite FTS5 | Useful for a requested conversation/lore/archive text search. Local in-memory `CREATE VIRTUAL TABLE ... USING fts5(text)` and `MATCH` succeeded on SQLite 3.53.4. Adds an index, write/delete maintenance, query/ranking rules, and UI. Removes no current machinery. Lexical search does not replace semantic Memory retrieval. |
| Compiled server or admin executable | `bun build --compile` could support a requested standalone distribution. Adds asset/plugin discovery and packaging work across platforms. SQLite data, artifacts, configuration, encryption key, and dynamically loaded Boxes remain distribution concerns. Current Docker deployment already works. |
| Better Auth | Official Elysia and Drizzle/SQLite integration makes it a plausible account/session system if multiuser becomes a requirement. Adds auth data and lifecycle plus ownership enforcement throughout the domain. A login endpoint alone does not create tenant isolation. No present requirement warrants it. |
| HTMLRewriter imports | Could extract external page metadata for a future importer. Adds source-format parsing and validation. It is not an automatic HTML sanitizer and does not replace browser rendering. |
| Durable background jobs | Consider only if work must survive restarts and have persisted retries/leases. Bun Cron supplies scheduling syntax; a timer is not a durable queue. The existing daily update interval is already a tiny, cancellable implementation. |

## Complete capability-family coverage

“Keep” includes capabilities already used or received through dependencies. “Conditional” means a concrete future requirement or measurement should precede adoption. The linked release audit contains the individual 1.4.4 additions and fixes, so they are not enumerated twice.

### Runtime, networking, and data

| Family | Verdict for this repo |
| --- | --- |
| TS/TSX/JSX execution, ESM/CJS resolution, Node/Web compatibility, built-in file loaders | Keep. Already runs the server, scripts, and tests directly. Browser code still needs a frontend build. |
| Watch / hot reload | Keep `--watch`; an in-process hot reload has state/DB/subscription lifecycle costs. Vite already owns browser HMR. |
| Runtime plugins / ModuleGraph | Conditional for a proven loader/isolation requirement. Box discovery and host/client contracts already exist. Experimental ModuleGraph resource ownership is not a plugin security sandbox. |
| `Bun.serve`, routing, static files, file-system router, HTTP errors | Keep Elysia and existing static/file serving. Switching to raw routes or a file router would recreate contract/middleware work. |
| Streaming, SSE, WebSockets / pub-sub | Investigate Elysia SSE above. Current generation delivery is server-to-client with replay; adding WebSockets introduces a protocol/lifecycle without a current bidirectional need. |
| Fetch, streaming uploads, TLS, DNS / preconnect / sessions | Keep native fetch and bounded/cancellable consumers. Pool/session and preconnect tuning need connection measurements. No separate HTTP client is needed just to use Bun. |
| Cookies / CSRF / password hashing | Conditional on an authentication/session design. They are not substitutes for route authorization or ownership. No password-hashing dependency to remove. |
| HTTP metrics, request IP, server lifecycle | Useful local diagnostics when needed. `pendingRequests` includes open SSE subscriptions, so it cannot measure active generations. Existing app lifecycle must still coordinate shutdown. |
| TCP / UDP / raw sockets | Skip: provider and browser traffic is HTTP/SSE. |
| File I/O, Blob/File, FileSink, Glob, binary utilities | Already uses Bun file serving and standard filesystem operations. Keep atomic writes, fsync, locks, and path checks where required; replacing every `node:fs` call is not an architectural gain. |
| Streams / ArrayBufferSink / stream conversion | Small accumulator opportunity above. Unbounded convenience conversion does not meet capped-response contracts. |
| Archive / compression | Conditional for a new backup/export format. No justification for an archive dependency or format change solely to call a built-in. |
| `bun:sqlite`, prepared statements, transactions, serialization | Keep. Drizzle already uses the native driver. Test fixtures already use DB serialization/deserialization. Row hooks do not replace publishing domain changes after commit. |
| SQLite FTS / extensions / vector search | FTS product candidate and sqlite-vec scale experiment above. No additional database server required. |
| SQLite backup | No `Database.backupTo` in the local runtime. `VACUUM INTO` can produce a DB snapshot, but a usable installation backup also includes artifacts and the encryption key. Do not silently replace the documented stopped-container backup with a live DB-only copy. |
| Bun SQL / PostgreSQL / MySQL | Skip a driver/database migration. Async SQL and external database support do not improve the existing synchronous SQLite/Drizzle design by themselves. |
| S3-compatible storage | Conditional on remote artifact storage. Adds configuration, remote failure/lifecycle behavior, and consistency decisions. Local persistence is already implemented. |
| Redis | Skip without a multi-process coordination/cache requirement. Would add another persistent service and operational surface. |
| Spawn / IPC / Bun Shell | Already uses subprocess tooling. Bun Shell is useful for a concrete cross-platform script; replacing existing explicit argument arrays with shell strings is not inherently simpler. |
| Workers | Conditional on measured CPU work blocking requests. Worker messaging/termination and ownership are additional machinery. Async provider I/O does not require worker threads. |
| Cron / timers | Keep small existing interval scheduling. Wall-clock schedules or durable work are distinct requirements. |
| Env / dotenv / env-file | Already supported. Bootstrap's duplicate-key checks and durable secret-key writes are intentional; automatic dotenv loading is not an equivalent replacement. |
| Secrets / OS credential storage | Skip as the current store: headless Docker plus encrypted persistent SQLite does not match experimental OS keychain dependencies (Linux requires libsecret/Secret Service). A desktop-only product could revisit the storage design. |
| SHA hashes / HMAC / password / UUID / CSRF | SHA-256 one-shot cleanup covered previously. Keep cryptographic identities cryptographic; `Bun.hash` is not SHA-256. UUIDv7 is not a replacement for random capability tokens or domain ordering. |
| TOML / YAML / JSON5 / XML loaders and parsers | Available for those formats when they are needed. No current parser dependency or format requirement motivates a migration. |
| JSONL | Current importer requires fatal UTF-8 and exact line failures. Native parse returns a valid prefix on malformed input in a local probe; do not silently change acceptance behavior. |
| Markdown | Keep browser `markdown-it` and current rendering rules. Server-native parsing is not a browser replacement; matching dialect/render/safety behavior would be real migration work. |
| HTMLRewriter / escapeHTML | Conditional server import/rewrite utility. The screenshot escape helper runs under Node; a Bun global would require changing that script's runtime too. |
| Images | Existing ingest removes EXIF while preserving other bytes/animation. Native decode/re-encode is not equivalent. Metadata probes and fixture differences are in the previous audit. |
| Semver / color / string width / inspect / deepEquals / peek / time / sleep | Use when a caller needs the semantics. No current semver protocol or terminal-layout dependency to eliminate. Do not refactor domain comparisons into generic deep equality or introduce promise peeking without a measured need. |
| Node-API / FFI / C compiler / Bindgen | Conditional native integration. Existing native frontend dependencies load through their packages. No custom C bridge is justified by current evidence. |
| WebView | No reason to replace the working Playwright user-flow harness with another browser automation API. Runtime availability is not test-runner parity. |

### Build, packages, and verification

| Family | Verdict for this repo |
| --- | --- |
| Bun bundler / fullstack dev / HTML static / standalone HTML | Keep Vite for now. Host-module chunks, import maps, Tailwind, Box externals/styles, CSS ownership validation, and dynamic Box loading are concrete requirements. A replacement must delete Vite machinery and reproduce behavior without growing custom build infrastructure. |
| CSS / React refresh / loaders / bundler plugins | Already supplied through Vite's React/Tailwind integration. Bun plugin compatibility is not proof that the current Vite plugins can be dropped in unchanged. |
| Transpiler / macros / defines / minifier | Conditional when build-time evaluation or transformation deletes actual runtime work. No identified hand-written transform warrants introducing macros. |
| Bytecode / compile / cross-compilation | Conditional distribution/startup optimization. Single-executable packaging is described above; no cold-start problem was measured. |
| Package install / lockfile / frozen CI / lifecycle trust / release age | Already Bun-based with a three-day minimum release age. Keep deterministic installs and review intentional dependency changes. |
| Global cache / virtual store / isolated installs / offline fetch | Cache reuse is useful; previous audit has details. New install topology requires checking tools/native packages; a single app does not need a monorepo to benefit from Bun. |
| Workspaces / catalogs / filters / recursive publish | Skip: one private package. Boxes are runtime plugins, not automatically independent npm workspaces. |
| `bunx` / link / patch / overrides / registries / package inspection | Use as maintenance tools when required. No speculative patches, overrides, or private registry infrastructure. Explicit Bun runtime selection for Vite is the concrete gap above. |
| `bun audit` / security scanner API | On-demand audit is available. A configured install scanner needs an actual chosen scanner; the docs' `@oven/bun-security-scanner` is explicitly a nonexistent placeholder. Do not add fictitious dependencies or automatic fix churn. |
| Formatter / native type checker | Formatter is missing; checker replacement is blocked by diagnostics differing from passing TypeScript. Installed Bun declarations lag the runtime. Detailed probes are in the previous audit. |
| Bun test runner / mocks / fake time / parallelism / isolation / preloads | Already heavily used, including parallel tests and fixture preloads. `--no-isolate` is explicit. Switching isolation changes shared module/mock/resource semantics; no blanket toggle is justified. |
| Coverage / matchers / snapshots / DOM tests | Available when a question requires them. No extra snapshot/component tests for UI tweaks, per project policy; no coverage gate merely to exercise a Bun capability. |
| Playwright / E2E | Keep the existing real-browser flows, one Bun server per worker, seeded DB, and strict scripted provider fixture. Bun compatibility does not imply parity with Node's test mocking APIs. |
| Debugger / CPU and heap profiles / benchmark tools | Underused diagnostic surface; profile a representative slow action before a performance rewrite. Upstream throughput numbers do not predict this application's benefit. |
| Init / create / templates / REPL | Useful for new projects or throwaway probes; not missing architecture in an existing repo. |

### Adjacent ecosystem

| Integration family | Verdict for this repo |
| --- | --- |
| Elysia / Eden / TypeBox | Already core. SSE is the identified smaller opportunity. OpenAPI is conditional on external client/documentation needs; tracing hooks are conditional on a request-phase diagnosis. |
| Hono / Express / Fastify / h3 / alternate server frameworks | Compatibility is not a reason to replace Elysia and its typed client. No missing framework capability was identified. |
| Drizzle / Prisma / Kysely / other SQL layers | Drizzle already targets `bun:sqlite` directly. An ORM swap would replace schema/query/migration machinery without an identified benefit. |
| libSQL / Turso / Neon / Supabase / MongoDB | Conditional on remote/multiuser persistence requirements. Bun integration does not remove migration, transaction, ownership, or deployment costs. |
| sqlite-vec / hosted vector databases | Local extension is worth a bounded benchmark. Hosted vector services add another consistency and operational boundary without a current requirement. |
| AI SDK / provider adapters / agent frameworks | Streaming integration already exists; embedding reuse is the gap above. Agent frameworks, gateways, or MCP servers need a requested agent/tool feature rather than a dependency consolidation pretext. |
| React / TanStack Query / RHF / Radix / Shadcn / CodeMirror / drag-and-drop | Browser responsibilities. Bun-native APIs do not replace these. |
| Next / Nuxt / Astro / SvelteKit / SolidStart / Qwik / Remix / TanStack Start / SSR | Skip a framework migration absent an SSR/routing/deployment requirement. Existing client SPA and Elysia server already cover current behavior. |
| Vite / Tailwind / Lightning CSS | Keep. Explicitly running Vite on Bun is separable from replacing its bundler. Box CSS validation consumes Lightning CSS's parsed selectors, not merely minified CSS. |
| markdown-it / eventsource-parser / RE2JS / tokenx | Browser/shared parsing and explicit semantics matter. Native regex lacks RE2's linear-time guarantee. Bun has no equivalent model-token estimator. SSE consumption, provider-activity tracking, and markdown rendering are distinct jobs from server frame formatting. |
| Better Auth / auth plugins | Conditional product addition, with domain ownership work. Do not install an authentication system just because it supports Bun. |
| Cron libraries / BullMQ / PostgreSQL-first queues / workflow engines | No evidence of a durable queue need. Redis or PostgreSQL queues would introduce a service that the app otherwise does not need. |
| Pino / OpenTelemetry / Sentry | Conditional on a concrete observability need. Current diagnostic/redaction policy must cover prompts, provider bodies, and credentials before exporting telemetry. Bun console/profile utilities are not a replacement log-retention system. |
| Docker / systemd / PM2 / serverless adapters | Docker packaging/publication already exists. Additional process managers or serverless adapters need a deployment requirement. Long-lived SSE and local SQLite need explicit consideration in any deployment change. |

## Verification and limits

| Probe | Observed result |
| --- | --- |
| Installed Elysia route returning `sse({ id: "7", event: "generation", data: { type: "text", text: "hello" } })` | HTTP 200, `text/event-stream`, correct id/event/JSON data lines. |
| Native `ArrayBufferSink`, two typed-array writes including a subarray | Final bytes `[1, 2, 3]`. |
| In-memory SQLite FTS5 table, insert, and `MATCH 'lantern'` | Matches `The lantern burns`; SQLite reports 3.53.4. |
| `typeof database.backupTo` | `undefined`. An upstream draft PR is not an installed capability. |
| Existing cosine helper vs installed `ai.cosineSimilarity` | Ordinary, orthogonal, opposite, zero, and empty probes agree approximately. Identical `[1,2]` vectors yield `1` vs `0.9999999999999998`; unequal lengths yield `0` vs an SDK argument error. |
| `bunx --no-install --bun vite --version` | Vite 8.3.4 starts and reports Bun runtime (`bun-v26.3.0`). Version output does not establish build/HMR correctness. |

All database probes used in-memory databases. No application code, dependency manifests/lockfile, persisted application database, or runtime configuration changed. This audit did not run a full application test suite. It measured no application speedup. Migration-specific checks are described with each candidate rather than presented as completed validation.

## Primary sources and repository evidence

- [Bun documentation catalog](https://bun.com/docs/llms.txt), [native APIs](https://bun.com/docs/runtime/bun-apis), [Node compatibility](https://bun.com/docs/runtime/nodejs-compat), and [ecosystem guides](https://bun.com/docs/guides/ecosystem/vite).
- Bun [streams](https://bun.com/docs/runtime/streams), [SQLite](https://bun.com/docs/runtime/sqlite), [SQL](https://bun.com/docs/runtime/sql), [secrets](https://bun.com/docs/runtime/secrets), [Workers](https://bun.com/docs/runtime/workers), [ModuleGraph](https://bun.com/docs/runtime/module-graph), [Cron](https://bun.com/docs/runtime/cron), and [environment variables](https://bun.com/docs/runtime/environment-variables).
- Bun [debugger/profiling](https://bun.com/docs/runtime/debugger), [benchmarking](https://bun.com/docs/project/benchmarking), [utilities](https://bun.com/docs/runtime/utils), [HTMLRewriter](https://bun.com/docs/runtime/html-rewriter), [compile](https://bun.com/docs/bundler/executables), [fullstack bundling](https://bun.com/docs/bundler/fullstack), and [install scanner API](https://bun.com/docs/pm/security-scanner-api).
- [Elysia streaming/SSE](https://elysiajs.com/essential/handler.md), [Eden](https://elysiajs.com/eden/overview), [trace hooks](https://elysiajs.com/patterns/trace), and the [older stream plugin's maintenance notice](https://elysiajs.com/plugins/stream).
- [Drizzle with Bun SQLite](https://orm.drizzle.team/docs/get-started/bun-sqlite-existing); sqlite-vec [Bun integration](https://alexgarcia.xyz/sqlite-vec/js.html) and [SQL API](https://alexgarcia.xyz/sqlite-vec/api-reference.html).
- AI SDK [embeddings](https://ai-sdk.dev/docs/ai-sdk-core/embeddings), [embedMany](https://ai-sdk.dev/docs/reference/ai-sdk-core/embed-many), [cosine similarity](https://ai-sdk.dev/docs/reference/ai-sdk-core/cosine-similarity), and [OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers).
- Better Auth [Elysia](https://better-auth.com/docs/integrations/elysia), [Drizzle](https://better-auth.com/docs/adapters/drizzle), and [SQLite](https://better-auth.com/docs/adapters/sqlite); [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite); [Playwright supported APIs/runtimes](https://playwright.dev/docs/intro).
- SQLite backup source-status caution: [draft Bun PR #26880](https://github.com/oven-sh/bun/pull/26880), plus the local absence probe above.
- Repo configuration: [manifest](../../package.json), [Bun config](../../bunfig.toml), [Vite config](../../vite.config.ts), [Dockerfile](../../Dockerfile), [Box build](../../scripts/build-box-client.ts), and [test harness](../../e2e/harness.test.ts).
- Runtime paths: [database](../../src/server/database/database.ts), [Memory ranking](../../src/boxes/memory/server-recall.ts), [embedding cache](../../src/server/box/embedding.ts), [embedding transport](../../src/server/model-client/embeddings.ts), [bounded response reader](../../src/server/model-client/model-fetch.ts), [AI SDK chat](../../src/server/model-client/chat-completions.ts), [generation SSE](../../src/server/contract/generation-sse.ts), [update SSE](../../src/server/contract/updates.ts), and [update interval](../../src/server/updates.ts).
