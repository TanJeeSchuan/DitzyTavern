# Bun 1.4.4 fit for DitzyTavern

Audited on 2026-10-22 at `52b9c25c`. This covers every feature section in the official [1.4.4 release notes](https://bun.com/blog/bun-v1.4.4), the smaller additions inside those sections, and earlier Bun capabilities available in this version. Fixes are grouped by subsystem. Upstream benchmark claims are not measurements of DitzyTavern.

The installed runtime, `packageManager`, and every Docker stage already use 1.4.4. The useful opportunities are developer tooling and cache reuse. Most runtime additions either arrive automatically or solve a problem this application does not have.

## Changes worth considering

1. **Add `bun fmt` with deliberate formatting settings.** There is no formatter command or formatter configuration. `bun fmt --doctor` recognizes the repository's files natively. Use tabs and choose a generous line width to respect the existing compact style. Tailwind sorting can be enabled separately. This introduces a formatter, configuration, and an optional check. It removes no dependency because no formatter is installed. Behavior changes are whitespace and optional ordering. Do not enable import sorting without reviewing side-effect imports.
2. **Add one development command with `bun run --parallel dev:server dev:client`.** Both scripts already exist. This introduces one script, removes the need to start two commands manually, and runs the same server and Vite processes. It does not require a process-manager dependency. Independent validation commands in `scripts/run-check.ts` could also run in parallel, but validate resource use before changing CI.
3. **Reuse the package cache between CI runs and Docker dependency stages.** The workflow installs dependencies in multiple jobs. The Dockerfile installs both full and production dependencies. Bun's cache archives, `bun pm fetch`, and offline installs provide mechanisms for sharing downloads. Start with an actual cache restore/save or shared cache mount. The existing Dockerfile already copies manifests before source, so inserting `bun pm fetch` alone adds a layer without fixing a demonstrated invalidation problem. This introduces cache plumbing and changes download work, not dependency versions.
4. **Use `Bun.SHA256.hash(value, "hex")` for one-shot hashes when touching those files.** It replaces `createHash("sha256").update(value).digest("hex")` in `src/server/hash.ts`, image ingest, and artifact hashing. It removes the per-call hasher construction expression and sometimes an import. It changes no digest format. Empty, ASCII, Unicode, and binary probes matched the current implementation. No application speedup was measured. Keep cryptographic SHA-256; `Bun.hash` has a different purpose.
5. **Update Bun's declarations when adopting newer runtime APIs.** Installed `@types/bun` and `bun-types` are 1.3.14. A compiler probe accepts Image and SHA256, but rejects FetchSession, SQLite `function`, and `onInsert` as missing properties. A suitable declaration update removes this mismatch without runtime adapter code. Check release-age policy and typecheck the update normally.
6. **Investigate `bun check`, but keep the working compiler commands until it agrees.** The tools project passes. The main project fails with three `TS2589` diagnostics while the existing TypeScript command passes. A replacement is therefore not ready. The `typescript5` dependency also supplies the compiler API to `scripts/check-contract-ownership.ts`; replacing a CLI does not remove that dependency.

`minimumReleaseAge = "3d"` would also express the existing `259200` setting more clearly. That is a one-line readability improvement, not a missing capability.

## Local evidence

| Command or probe | Result |
| --- | --- |
| `bun --version` | `1.4.4`. |
| `bun run typecheck` | Passes. |
| `bun run typecheck:tools` | Passes. |
| `bun check --no-script --noEmit` | Fails with `TS2589` at `src/client/conversation.ts:217`, `src/client/workspace/useAssemblyController.ts:65`, and `src/server/contract/conversation.ts:323`. |
| `bun check --no-script --noEmit -p tsconfig.tools.json` | Passes. |
| `bun fmt --doctor` | Finds no Prettier or oxfmt configuration and reports native formatting support. |
| `bun fmt --check --use-tabs src/server/image/ingest.ts` | Reports formatting changes. It does not write the file. An initial whole-repo gate would need a formatting decision first. |
| `Bun.JSONL.parse('{"ok":true}\n{broken}\n')` | Returns the valid first record without throwing. |
| `Bun.JSONL.parseChunk` on that input | Returns the first record and a parse error. |
| `Bun.Image.metadata()` on the existing JPEG, WebP, and GIF fixtures | JPEG and GIF dimensions match. The synthetic WebP fixture fails with `ERR_IMAGE_DECODE_FAILED`. This is a contract difference to resolve before replacement, not evidence that real WebP images fail. |
| SHA-256 comparison | `Bun.SHA256.hash(input, "hex")` matches `node:crypto` for empty, ASCII, Unicode, and binary inputs. |
| Declaration probe with installed TypeScript 7 | Image and SHA256 typecheck. FetchSession, SQLite `function`, and `onInsert` report `TS2339`. |

The package has a `"check"` script. `bun check` invokes that script instead of the built-in checker. The explicit `--no-script` above is necessary for this comparison.

No application code, dependency versions, formatter configuration, or CI commands were changed by this audit. The checks above are targeted probes, not a full application test run.

## Every 1.4.4 feature section

These rows follow the official article. "Automatic" means the runtime or existing command receives the change without application code changes. "Skip" means no current use case warrants adoption. "Investigate" identifies a concrete limitation or unproven benefit.

### Formatter

| Release item | Repository fit |
| --- | --- |
| `bun fmt` | Adopt after choosing style settings. Covers JS, TS, JSX, CSS, HTML, JSON, YAML, TOML, Markdown, and other supported formats without another formatter package. |
| `bun fmt --check` | Useful optional CI gate after the formatting baseline is intentional. |
| `bun fmt --staged` and `--changed` | Useful for bounded formatting. `--staged` also re-stages files, so it is a workflow choice. No lint-staged dependency exists to remove. |
| Prettier and oxfmt configuration support | Available, but this repo has no such configuration to migrate. Reads overrides, editorconfig, ignore files, and supported plugin options. |
| `[fmt]` in `bunfig.toml` | Natural configuration location. Tabs, width, semicolons, and overrides can match repo preferences. Import sorting, Tailwind sorting, package.json sorting, and JSDoc formatting are opt-in. |
| Built-in Tailwind, package.json, and Svelte plugin behavior | Tailwind and package.json sorting are relevant. Svelte is unused. There are no existing formatter plugins to uninstall. |
| Intentional differences from Prettier | Relevant during adoption: Bun preserves meaning for documented CSS and Handlebars edge cases. `--debug-check` checks that formatting preserves the parsed structure. No reason to run it as an application test. |
| Testing `bun fmt` | Upstream validation evidence, not a separate feature to enable. Check this repo's actual output before choosing a baseline. Unsupported formatter plugins can fail instead of silently formatting files. |

### Type checking

| Release item | Repository fit |
| --- | --- |
| Faster `bun check` on large projects | Investigate. Introduced in 1.4.3 and improved here. Main-project diagnostics differ from the passing compiler. No local speed comparison is meaningful until the behavior agrees. |
| Faster `bun check -b` across many projects | Skip. This repository has two configurations, not a project-reference monorepo. |

### Package manager

| Release item | Repository fit |
| --- | --- |
| Yarn Berry lockfile migration | Skip. Already uses `bun.lock`. |
| Exponential retry backoff | Automatic for installs. Retry-After handling and retrying 408/429 responses improve registry outage behavior. Tune `BUN_CONFIG_HTTP_RETRY_BACKOFF` only if real failures justify it. |
| 133 install issues closed | Automatic fixes, not another configuration feature. |
| Parallel hoisted linking from a warm cache on Linux | Automatic where the install and cache meet those conditions. Restoring a cache would make this more useful in CI. |
| Linux libc filtering and `--libc` | Automatic for dependency metadata that records libc. Relevant to native packages such as lightningcss. Existing older lock entries acquire the metadata on update or lock regeneration. Do not force musl for the current standard Bun image. |
| Peer resolution closer to pnpm | Automatic on resolution. Relevant to Elysia/TypeBox and React dependencies. Locked versions do not change automatically. |
| `bun pm fetch` | Conditional cache opportunity. Downloads only, with no node_modules, scripts, or lockfile mutation. Existing manifest-first Docker layers already cache a full install. |
| `bun pm cache pack`, `unpack`, `prune` | Useful candidates for portable runner caches. Prune is cache maintenance, not something to run on every build. |
| `bun publish --recursive` and `--filter` | Skip. Private single-package application; publication uses Docker, not npm workspaces. |
| `packageExtensions` | Skip. No demonstrated missing third-party dependency declaration. Do not add speculative dependency patches. |
| Path-based `link:` dependencies | Skip. Box plugins are discovered from folders and built against host modules, not linked npm packages. |
| Deprecated-package warnings and resolution preference | Automatic. Review warnings during intentional updates. Locked packages stay pinned. |
| Release-age units and per-version exclusions | Existing protection is already enabled. `"3d"` improves readability. Use a version-specific exclusion only for an identified urgent update. |
| Package-manager `--env-file` and `bunx` flags | Available for explicit environments, alternate cwd, release age, and lifecycle trust. Current Playwright calls use `--no-install`; no missing use case was found. |
| `bun add --dev`, `--optional`, `--peer` move existing entries | Useful maintenance behavior. No dependency is currently identified as misclassified. |
| `NPM_CONFIG_USERCONFIG` from setup-node | Automatic when used. Current dependencies do not require a private npm registry. |
| npm, Yarn, pnpm flag translations and unknown-flag rejection | Automatic. Keep native Bun flags in this repo rather than adding aliases. Unknown flags now fail, including typos in frozen-lockfile options. |
| More in `bun install` | Every smaller addition is assessed below. |

The "More in bun install" section adds these individual behaviors:

| Addition | Repository fit |
| --- | --- |
| `bun update --depth 0` | Useful during deliberate direct-dependency updates when transitive versions should stay pinned. |
| `bun prune --check` | Optional local diagnosis of stale node_modules. Fresh CI installs do not need another gate. |
| `publishConfig` registry settings and explicit prerelease tags | Skip. No npm publication. |
| `workspace:*` can reference root | Skip. No workspaces. |
| npm-shrinkwrap migration | Skip. Bun lockfile already exists. |
| `hasInstallScript` lockfile metadata | Automatic on lockfile generation. Makes blocked-script reporting more informative. |
| Dependency-specific frozen-lockfile diagnostics | Automatic in existing CI and Docker commands. |
| More commands honor `--dry-run` | Useful for interactive package maintenance. Covers link, unlink, version, cache removal, trust, package edits, and migration. No need for a script around it. |
| `bun pm pkg` arrays and bracketed keys | Available maintenance convenience. No current hand-written package editor to replace. |
| `bun pm view` and `bun info` fields and paths outside projects | Useful for inspection, not an application change. |
| Retries in info, view, whoami, and audit | Automatic for those commands. |
| `bun pm ls` package filters, production, omit, and depth | Useful for dependency inspection. |
| Version lifecycle environment variables | Skip. No npm version lifecycle scripts. |
| Dependency lifecycle package environment variables | Automatic where dependencies run scripts. |
| `gypfile: false` suppresses implicit node-gyp | Third-party package author behavior. No local native addon. |
| `bun create --ignore-scripts` and configured script restrictions | Skip for application operation. Relevant only when creating another project. |
| `bunx -p pkg cmd` | Maintenance convenience. No reason to replace existing pinned, no-install Playwright invocation. |
| Auto-install registry credentials | Skip. Explicit locked installs already own dependency setup. |
| Auto-install respects lockfile versions | Available, but explicit frozen installation is already clearer here. |
| Auto-install honors dependency groups, overrides, resolutions, and workspaces | Same conclusion. Do not introduce implicit installation to use this feature. |
| Security scanners receive all resolved dependency sources | Automatic for a configured scanner. No custom scanner integration was identified. |
| Registry metadata Cache-Control is respected | Automatic. Includes no-cache, no-store, and short max-age values. |
| `--use-system-ca` on package commands | Useful only for an environment with a required system certificate authority. No current missing trust configuration was identified. |
| Leading `~/` in install/cache/global/bin/userconfig environment paths | Maintenance convenience. No current path workaround to remove. |
| `bun audit fix` rewrites vulnerable override rules | Useful during intentional dependency remediation. Do not mutate overrides as an implicit CI step. |
| Faster Yarn v1 migration and lower install memory in large monorepos | Skip. No Yarn migration or workspace graph. |
| Non-quadratic patch application | Automatic if patches are used. No current patch workflow to simplify. |
| Global-store no-op installs preserve links | Automatic when globalStore is enabled. It is not enabled here. Revisit only for demonstrated repeated-install costs. |

### SQL and SQLite

| Release item | Repository fit |
| --- | --- |
| Lower CPU per `Bun.SQL` query | Skip migration. The app uses `bun:sqlite` with Drizzle, not `Bun.SQL`. The published percentage does not describe this app's queries. |
| PostgreSQL `query.cancel()` | Skip. No PostgreSQL client. |
| PostgreSQL COPY streams | Skip. No PostgreSQL bulk transfer. |
| Column name transforms | Skip. Drizzle already owns row projection and schema names. |
| JavaScript arrays for PostgreSQL arrays | Skip. No PostgreSQL array columns. |
| `result.columns` and `result.statement` | Skip. No `Bun.SQL` consumer. Metadata is null for its SQLite adapter. |
| `sql.json()` | Skip. Existing Drizzle/schema serialization already owns JSON fields. |
| Database connection reuse under `bun --hot` | Skip. The server uses `--watch`, local SQLite, and explicit shutdown ownership. This change concerns PostgreSQL/MySQL SQL pools. |
| New SQL connection options | Skip. Channel binding, certificate callbacks, foundRows, URL timeout/pool options, libpq parameters, and PostgreSQL environment variables have no consumer here. |
| SQLite `db.function()` and `db.aggregate()` | Available for a demonstrated SQL computation. Includes deterministic/directOnly/safeIntegers/varargs and inverse window aggregates. No current JS loop is clearly simplified enough to warrant a callback inside SQL. Do not move image-reference scanning into a UDF merely because it is possible. |
| SQLite update hooks | Skip as a domain-observer replacement. Hooks identify database/table/rowid, not ConversationWriteChange. They fire for row operations, not the application's after-commit publication boundary. The explicit observer in `conversation/commands/transaction.ts` also prepares effects inside the transaction and discards publication on failure. |
| SQLite statement `reader`, `readonly`, and database type marker | Useful library introspection. No local statement classifier or driver detector to remove. |

### WebSocket

| Release item | Repository fit |
| --- | --- |
| Native `ws` rewritten toward npm ws behavior | Dependency compatibility benefit when a tool uses it. Application generation uses HTTP/SSE. No reason to change transport. Adds stream integration/backpressure, agents and custom connection hooks, redirect and handshake options, max payload, compression, Duplex integration, and socket pause/resume behavior. |
| Node-compatible ws events and defaults | Automatic for Bun-hosted ws consumers. Error values, close reasons, CONNECTING send errors, payload limits, and default timeout/ping behavior change. Check listeners if a future direct ws consumer is added. |
| Global WebSocket closing handshake | Automatic. Close now waits for the peer and can delay process exit. `terminate()` and the configurable timeout are relevant only for an actual socket lifecycle. |
| Failed connections emit error then close 1006 | Automatic for consumers. Node-style error codes are available. No application handler to revise. |
| `Bun.serve` socket pause/resume/isPaused | Skip. No application WebSocket ingestion queue. |
| `websocket.error(error, socket)` | Skip. No application WebSocket handler. |
| Separate `proxy.tls` options | Skip. Model networking uses HTTP fetch, not this WebSocket API. |

### Runtime and dev server

| Release item | Repository fit |
| --- | --- |
| JavaScriptCore upgrade | Automatic on Bun-hosted code. Includes number/BigInt locale formatting, large arrays, string iteration, small arrays, exceptions, WeakMap, correctness fixes, and Wasm register allocation. Browser React code still runs in the user's browser engine. |
| Glob extglob and brace ranges | Available for genuinely complex file selection. Existing Box discovery uses one directory read plus sorting and validation. Replacing it with a glob adds little. New syntax also affects filters and package manifest glob fields. |
| Faster Headers iteration | Automatic for Bun-hosted header consumers. No wrapper needed. |
| Faster in-memory Response/Request/Blob body streams | Automatic. Does not establish a speedup for remote provider SSE. |
| Stronger `--disallow-code-generation-from-strings=strict` | Do not enable blindly. Elysia/TypeBox compilation and executable plugin loading require investigation. In compiled programs, strict mode rejects external executable files, which conflicts with disk-installed Box modules. It is not a plugin sandbox. |
| Redesigned Bun HTML dev-server error overlay | Skip. Frontend development uses Vite. Replacing Vite also means replacing Tailwind integration, import-map/host chunks, and Box client build behavior. An overlay is insufficient reason. |

The release's "Other improvements" section also covers all of these:

- Lower `node:http` header overhead, faster JSON5 parsing, faster Glob matching, faster non-ASCII WebSocket echo and Markdown rendering, faster hashing, faster TextDecoder construction, and a compile-cache exit regression fix. These arrive automatically for matching Bun-side code. The hash simplification is the only direct cleanup identified above.
- Updated NSS root certificates and more supported libuv functions for native addons. These improve platform compatibility without new app configuration.
- FreeBSD binaries now target 14.4. This application's current Docker publication targets Linux amd64 and arm64.

## Fixes that matter to existing behavior

The release reports 271 fixed issues. They are not 271 new APIs. The full [official fix list](https://bun.com/blog/bun-v1.4.4#bugfixes) remains the authority for individual reproductions.

| Fix family | Effect here |
| --- | --- |
| `bun:sqlite` multi-statement runtime errors | Database initialization and migrations receive proper failure propagation instead of swallowing earlier statement errors. |
| SQLite async transaction callback rejection | Returning a rejected promise rolls back. Application transactions should still be synchronous. |
| SQLite statement metadata after ALTER TABLE | Relevant to schema changes and cached statements. Automatic. |
| SQLite bindings, changes counts, iterator cleanup, and exit commits | Automatic. Changes now exclude trigger/cascade writes. Review any caller that relies on exact counts when changing it. |
| SQLite statement memory accounting, query cache, and `get()` behavior | Automatic for existing Drizzle and raw queries. No need to switch database APIs for these improvements. |
| SQLite worker allocator and FTS index correctness | Automatic for matching use. Heap-limit pragmas no longer enforce limits after allocator separation. |
| `Bun.SQL` pool, transactions, result typing, adapters, and connection fixes | Mostly outside the app's chosen SQLite API. They do not justify an adapter migration. |
| `node:sqlite` fixes | No direct application consumer. |
| Coverage branch/line/function/hit accounting | Relevant if coverage is enabled later. Percentages can decrease because accounting is more accurate. No coverage gate exists in the current test script. |
| `bun test`, changed tests, and interrupted snapshot updates | Existing Bun tests receive fixes. Snapshot behavior does not justify adding UI snapshots against repo policy. |
| Lockfile, frozen installs, dependency resolution, linkers, registry, lifecycle, archives, Git, and Windows package-manager fixes | Existing install commands receive relevant fixes. |
| `Bun.serve`, fetch, streams/Blob, TLS, WebSocket, and Web APIs | Existing Elysia, fake provider, update checker, and HTTP paths receive matching fixes. |
| Bun hash APIs, Glob, and other Bun API fixes | Automatic where consumed. |
| Node http/http2/fs/vm/stream/crypto/util/process/diagnostics/worker/native-addon compatibility | Benefits compatible libraries and scripts. Node-invoked tools continue running on Node. |
| Runtime, hot/watch, run, and transpiler | Existing server watch mode receives matching fixes. No reason to replace watch with hot reload. |
| JS bundler, compile, CSS parser, and Bun HTML dev server | Limited direct effect because frontend and Box clients build with Vite. Runtime transpilation still uses Bun. |
| Bun Shell | Available, but there is no current Bun Shell command pipeline to repair or simplify. |
| Type definitions | Release corrects matcher, hash, mmap, hasher, resource-usage, and router types. The repo's installed `@types/bun` and `bun-types` are both 1.3.14, so runtime availability and installed declarations must be checked separately before adopting newer APIs. |
| Security fixes | Covered protocols include TLS, HTTP, WebSocket, Brotli, database clients, Image, Archive, crypto, and package commands. The 1.4.4 pin already brings the runtime fixes. No unrelated security configuration is proposed. |

## Earlier capabilities available in 1.4.4

The [1.4 overview](https://bun.com/blog/bun-v1.4) includes features introduced during 1.3 as well as new 1.4 features. The rows below describe availability in the audited version; they do not claim all were introduced in 1.4.4.

| Capability | Repository fit |
| --- | --- |
| `bun run --parallel` and script globs | Useful combined dev command. Independent CI commands are a separate resource-use decision. |
| `bun test --parallel` and isolation controls | Already used: `--parallel=3 --no-isolate` with two preloads. Keep the chosen shared-module behavior unless a real leak appears. |
| Test `--timings`, `--changed`, `--shard`, `--only-failures`, and grep | Useful investigation/iteration tools. Use existing preloads via the package script. Changed-test selection is not a substitute for a full release check. Sharding needs evidence of CI benefit. |
| Test retries, fake timers, lifecycle callbacks, and disposable spies | Fake timers already appear in tests. Retries would conceal deterministic failures. Use automatic spy cleanup only where it removes actual cleanup code. No broad test rewrite. |
| Built-in type checking and run/test/build `--check` from 1.4.3 | Main-project disagreement blocks adoption, including combined check-and-test flags. Tools-only check passes but removes no compiler-API dependency. |
| `Bun.Image` | Investigate metadata-only replacement for handwritten JPEG/WebP dimension readers. Do not re-encode uploads: ingest tests require pixel chunks/animation and unrelated bytes to survive EXIF stripping. The existing synthetic WebP fixture is rejected by Bun metadata. Thumbnails/placeholders are new product features, not a cleanup. |
| `Bun.markdown` | Skip as a markdown-it replacement. `src/client/story/prose.tsx` runs in the browser and customizes tokenization, dialogue delimiters, image references, block boundaries, and streaming reveals. A server Bun API does not replace that contract. |
| `Bun.JSONL.parse` and `parseChunk` | Plain parse is unsuitable for imports because it accepts a valid prefix before a later error. Chunk parsing exposes errors but preserving fatal UTF-8 handling and precise line diagnostics still needs code. No demonstrated simplification over the current small parser. |
| JSON5, JSONC, XML, TOML, and YAML | No missing format consumer. SillyTavern JSON should remain strict. Expanding accepted syntax changes product behavior. |
| `Bun.WebView` | Browser automation is available, but Playwright already supplies contexts, locators, fixtures, assertions, reports, and seeded server integration. A second browser system would add machinery. |
| `Bun.cron()` | The update checker needs an interval since startup, not a wall-clock schedule. It already owns start/stop and settings changes. Keep the timer. |
| `Bun.Terminal`, ANSI utilities, and FFI | No interactive PTY, terminal rendering, or native-call requirement in application operation. |
| `Bun.Archive`, S3, Redis, UDP, low-level sockets, CSRF helpers, password hashing, and newer crypto algorithms | No current matching replacement. Artifact files, local images, and encrypted provider keys have distinct existing contracts. Do not add infrastructure to exercise an API. |
| `Bun.file`, `Bun.write`, and response-to-file streaming | File-backed responses and byte reads are already used. Artifact verification hashes exact fully read bytes. Streaming output alone does not remove that integrity work. Revisit streaming only for demonstrated large-file pressure. |
| Bun subprocesses and Shell | `Bun.spawn` already runs checks, publication commands, and process tests. Shell may replace a real quoting pipeline, but the remote runner intentionally sends Bash to another host. |
| CPU and heap Markdown profiles, memory-pressure events, and build metafiles | Useful on demand when diagnosing cost. Vite owns the browser bundle, so Bun's bundler metafile is not its report. No permanent profiling script or pressure handler is needed without a consumer. |
| Global virtual package store, offline/prefer-offline installs | Conditional on repeated local installs or a restored cache. Avoid changing linkers solely for an upstream benchmark. |
| `bun audit fix`, `dedupe`, `prune`, package diff and licenses | Useful maintenance commands. Run fixes as intentional dependency changes, not hidden CI mutations. No need for permanent scripts for every command. |
| Workspace catalogs, nested overrides, filtered installs, and self-contained node_modules | No monorepo/workspace use case in this private application. |
| Built-in React Compiler and browser bundling | React optimization is an experiment requiring actual UI measurements. It does not remove the existing Vite/Tailwind/Box client integration. |
| Compile-time flags, in-memory builds, barrel optimization, decorators, HTML output, assets, and code splitting | No current Bun build path to improve. Do not migrate bundlers for feature count. |
| Standalone executables and cross-compiled bytecode | Current delivery is Docker with runtime-loaded Box TypeScript, migrations, and static output. A standalone executable would be a separate distribution design. |
| Native TypeScript stripping | The server already runs TypeScript directly through Bun. Node tooling already has its own TypeScript execution path. |
| HTTP/2 serving, experimental HTTP/3, and experimental fetch HTTP/2/3 | Do not change protocols without a deployment/provider requirement. The server currently listens on plain HTTP through Elysia. |
| FetchSession from 1.4.3 | Conditional fit for per-profile TLS, proxy, and connection-pool isolation. Sessions own distinct pools and accept request overrides. No current profile-level TLS/proxy settings or custom pool workaround was identified. Model fetch still needs its credential, destination, cancellation, and SSE activity logic. Add a session only when that network policy is required. |
| Experimental ModuleGraph | No current dependency-graph consumer. Do not replace ordinary module loading with an experimental graph API. |
| Compression levels and request compression | No current compressed request contract. Provider compatibility must be established before enabling it. |
| File/folder serving, Range/If-Range, and conditional requests | Native file responses are already used; Elysia static handling owns caching and SPA behavior. Switching serving APIs requires preserving host chunks, Box assets, and fallback routing for little demonstrated gain. |
| TLS session/connection reuse, stream backpressure, and proxy improvements | Automatic for matching fetch usage. No custom pool is needed merely to expose these improvements. |
| Node/Playwright/Vitest/observability compatibility | Compatibility enables choices; it does not require switching the already-working Playwright harness or adding a tracing package. |
| Temporal and JavaScriptCore improvements | No need to replace timestamp strings or interval arithmetic. Runtime speed/correctness improvements already apply to Bun-side code. |
| Rust rewrite, idle CPU/memory/startup improvements, platform support | Automatic with the runtime upgrade. Platform additions do not change the declared Linux Docker targets. |

The [1.4.1 notes](https://bun.com/blog/bun-v1.4.1) add HTTP/2 serving, streaming writes, WebSocket flow control, Argon2, offline installs, workspace packaging, bundler improvements, and compiled-bytecode changes. They are assessed above. The [1.4.2 notes](https://bun.com/blog/bun-v1.4.2) are fixes, including Elysia bundling, AsyncLocalStorage, worker events, Image JPEG decoding, and engine/GC correctness. The [1.4.3 notes](https://bun.com/blog/bun-v1.4.3) add check, FetchSession, experimental ModuleGraph, code-generation restrictions, compression levels, If-Range, build naming/memory changes, and compile-bytecode improvements. They are also assessed above.

## Sources and repository anchors

Primary sources:

- [Bun 1.4.4 release](https://bun.com/blog/bun-v1.4.4), including every feature subsection, smaller package-manager additions, security section, and fix families.
- [Bun 1.4 overview](https://bun.com/blog/bun-v1.4), [1.4.1](https://bun.com/blog/bun-v1.4.1), [1.4.2](https://bun.com/blog/bun-v1.4.2), and [1.4.3](https://bun.com/blog/bun-v1.4.3).
- [Image API](https://bun.com/docs/runtime/image) for metadata, pipeline output, animation/format constraints, and platform differences.
- [JSONL API](https://bun.com/docs/runtime/jsonl) for valid-prefix parsing and explicit chunk errors. The dangerous prefix behavior was also reproduced locally.
- [Formatter documentation](https://bun.com/docs/format) and [type-checker documentation](https://bun.com/docs/runtime/check), checked against installed command help.

Repository evidence:

- [package.json](../../package.json), [bunfig.toml](../../bunfig.toml), [Dockerfile](../../Dockerfile), and [CI workflow](../../.github/workflows/check.yml).
- [Check runner](../../scripts/run-check.ts), [contract audit](../../scripts/check-contract-ownership.ts), and [Docker publication](../../scripts/publish-docker.ts).
- [Vite configuration](../../vite.config.ts), [Box client build](../../scripts/build-box-client.ts), and [Box discovery](../../src/server/box/registry.ts).
- [Database setup](../../src/server/database/database.ts) and [Conversation transactions](../../src/server/conversation/commands/transaction.ts).
- [Image ingest](../../src/server/image/ingest.ts), [image contract tests](../../src/server/image/ingest.test.ts), [image store](../../src/server/image/store.ts), [artifact store](../../src/server/artifact/store.ts), and [text hash helper](../../src/server/hash.ts).
- [SillyTavern record decoding](../../src/server/sillytavern/adapter/messages.ts), [browser prose renderer](../../src/client/story/prose.tsx), [model adapter](../../src/server/model-client/adapter.ts), [provider request wrapper](../../src/server/model-client/chat-completions.ts), and [update checker](../../src/server/updates.ts).
