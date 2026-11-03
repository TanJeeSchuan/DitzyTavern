# Bun opportunities in DitzyTavern

2026-10-25 · checkout `5c33cd12` · installed Bun 1.4.4

The repo uses Bun's main strengths already. The useful gaps are development commands, formatting, dependency caching, and a few narrow APIs. There is no evidence that adopting more Bun subsystems would improve the application.

This review fetched the official [documentation catalog](https://bun.com/docs/llms.txt), [full documentation export](https://bun.com/docs/llms-full.txt), runtime, formatter, checker, hashing, cache and package-manager docs, and [1.4.4 release article](https://bun.com/blog/bun-v1.4.4). The [capability catalog](bun-capability-catalog-verification.md) covers the documented feature families. The earlier [release audit](bun-1.4.4-feature-audit.md) covers individual 1.4.4 additions. Their older application recommendations need the corrections below. Live docs are unversioned; for example, the current package-manager page includes 1.5.0 example output. A documented feature is not proof of local availability.

## Worth doing

### 1. One development command

[`package.json`](../../package.json) has `dev:server` and `dev:client`, but no combined command. Bun already supports:

```json
"dev": "bun run --parallel dev:server dev:client"
```

Removes the manual two-command startup. Introduces one script and uses Bun's existing process orchestration; introduces no dependency. Product behavior is unchanged. The local `bun run --help` confirms `--parallel`, `--sequential`, and `--no-orphans`. Consider the last flag if descendant cleanup is a real development problem; process trees and signals need verification before claiming cleanup is solved. [Source](https://bun.com/docs/runtime).

### 2. Adopt `bun fmt` deliberately

There is linting but no formatter script or `[fmt]` configuration. Local `bun fmt --doctor` confirms native file support and no Prettier/oxfmt configuration to migrate.

Removes manual formatting decisions; introduces style configuration and, optionally, a check command. Behavior changes are formatting and any explicitly enabled sorting. Choose tabs and a width suitable for the compact code style. Inspect a bounded diff before choosing a baseline. Adding a gate before that baseline would create avoidable failures. No formatter package can be removed because none is installed. `--staged` also stages its changes; use it as an intentional workflow choice. [Source](https://bun.com/docs/format).

### 3. Reuse Bun's package cache across fresh CI jobs

The [workflow](../../.github/workflows/check.yml) installs dependencies in separate jobs without an explicit Bun-cache restore/save. The [Dockerfile](../../Dockerfile) has separate full and production dependency stages.

Removes repeated registry downloads when a cache is restored. Introduces cache plumbing keyed appropriately for the platform, Bun version, and lockfile, or a shared BuildKit cache mount for compatible dependency stages. Dependency versions and application behavior should stay unchanged. Cache effectiveness and CI duration were not measured here.

Start with `~/.bun/install/cache`, not an unvalidated cross-platform `node_modules` archive. Native dependencies need the correct target. The Dockerfile already installs after copying manifests and before copying source: adding `bun pm fetch` alone does not improve that existing layer boundary. The installed package-manager's cache pack/unpack and fetch commands are alternatives when the runner needs portable cache transport, not mandatory extra steps. [Global cache](https://bun.com/docs/pm/global-cache), [package-manager utilities](https://bun.com/docs/pm/cli/pm).

### 4. Use one-shot SHA-256 where it shortens existing code

`Bun.SHA256.hash(value, "hex")` can replace one-shot `createHash("sha256").update(value).digest("hex")` in the [text helper](../../src/server/hash.ts), [image ingest](../../src/server/image/ingest.ts), [artifact store](../../src/server/artifact/store.ts), and [Box seed](../../src/server/box/seed.ts).

Removes chained hasher construction and imports that become unused. Introduces a Bun API call; preserves the SHA-256 digest and exact input bytes. Local empty, ASCII, Unicode, and binary comparisons matched Node's crypto implementation. No speedup is claimed. Keep incremental hashing incremental and leave AES/HMAC/randomness alone. `Bun.hash` is a different, non-cryptographic operation. [Source](https://bun.com/docs/runtime/hashing).

### 5. Align Bun declarations when adopting newer APIs

The runtime is 1.4.4; installed `@types/bun` and `bun-types` are 1.3.14. Updating declarations is maintenance rather than a product feature, but it avoids inventing casts or declarations for APIs the runtime already supplies.

Removes stale type descriptions; introduces an ordinary dependency/lockfile update. Runtime behavior should not change; compiler diagnostics can. Select a published version under the existing release-age policy and run both TypeScript projects. No dependency update was performed. [Source](https://bun.com/docs/typescript).

## Bounded experiments

- **Vite on Bun:** current `vite` scripts respect Vite's Node shebang. `bun --bun run build` selects Bun without replacing Vite, React/Tailwind plugins, host chunks, import maps, or Box builds. This removes Node execution for those commands and introduces an explicit runtime choice. It does not remove the repo's Node requirement: lint-rule tests, harness tests, and screenshot tooling still select Node. Build validation is recorded below; HMR and browser/Box flows need their own verification before changing defaults. [Source](https://bun.com/docs/guides/ecosystem/vite).
- **Faster test iteration:** use `bun run test --changed <base>` for a bounded development run while retaining the existing preloads, exclusions, and worker settings. `--timings` can schedule slow files first; `--update-timings` records durations. These change selection/scheduling and add an optional timing artifact, not application behavior. They do not replace the full check. `--only-failures` only hides passing output; it does not rerun only previously failed tests. Local test help confirms these flags. [Sources](https://bun.com/docs/test/discovery), [parallel tests](https://bun.com/docs/test/parallel).
- **Image metadata:** `Bun.Image` could remove handwritten JPEG/WebP dimension readers. It introduces native metadata decoding and changes the definition of an acceptable image: the earlier audit found a synthetic WebP fixture accepted by the current header reader but rejected by Bun. Decide that behavior intentionally. Decode/re-encode cannot replace byte-preserving EXIF removal without changing the existing contract. [Source](https://bun.com/docs/runtime/image).
- **Memory ranking:** loading a native SQLite vector extension could move distance scoring and top-k selection into SQL. This adds extension packaging and query/schema ownership while removing some JS scoring/sorting. Current cached vectors already remain Float32 views: the old boxed-array allocation argument is obsolete. Benchmark the current implementation first; preserve candidate eligibility, vector-space isolation, dimensions, deterministic ties, recent candidates, and Decision Model judging. `sqlite-vec` is an external extension, not a Bun built-in. [SQLite extensions](https://bun.com/docs/runtime/sqlite), [sqlite-vec Bun integration](https://alexgarcia.xyz/sqlite-vec/js.html).

CPU and heap profiling are useful on demand, and the existing accumulator profile shows they are already being used. Another permanent profiler abstraction is unnecessary. [Source](https://bun.com/docs/runtime/debugger).

## Keep the current implementation

- **ArrayBufferSink:** the newer [production-derived profile](bun-arraybuffer-sink-profile.md) supersedes the older recommendation. It found no measurable single-request client advantage and a regression with concurrent large embedding responses. No new benchmark was run for this review. Keep the bounded reader.
- **`bun check`:** a fresh `bun check --no-script --noEmit` run reports `TS2589` at `src/client/conversation.ts:217`, `src/client/workspace/useAssemblyController.ts:65`, and `src/server/contract/conversation.ts:323`. The configured compiler comparison is recorded below. The existing `check` script takes precedence over the built-in command, so `--no-script` is essential. Switching would change diagnostic behavior. The TypeScript 5 compiler API also has a separate tools consumer; replacing a CLI does not remove it. [Source](https://bun.com/docs/runtime/check).
- **Native JSONL:** a fresh local probe of `Bun.JSONL.parse` returns the valid prefix before a malformed second record. The current importer rejects malformed records with line diagnostics and performs fatal UTF-8 decoding. Replacing it with the convenience parser changes import acceptance. Chunk parsing exposes errors but still needs contract work. [Source](https://bun.com/docs/runtime/jsonl).
- **Native Markdown:** rendering runs in the browser with application-specific tokenization and streaming behavior. A server-only Bun global cannot remove that browser dependency. [Source](https://bun.com/docs/runtime/markdown).
- **Native HTTP/fullstack bundling:** Elysia and Vite already own routing/contracts, static assets, Tailwind, HMR and Box build integration. Replacing them would introduce custom equivalents. `--hot` likewise changes lifecycle ownership compared with restarting the server under `--watch`. No measured problem justifies either migration. [HTTP](https://bun.com/docs/runtime/http/server), [fullstack bundling](https://bun.com/docs/bundler/fullstack).
- **SSE helpers:** Elysia's helper can shorten wire framing but callback subscriptions still need replay, cancellation and cleanup. A generator queue can cost more code than it deletes. This is an Elysia opportunity, not an unused Bun API; no migration is justified by feature coverage alone.

## Other families checked

Already used directly or through existing libraries: TS/TSX execution, Node/Web compatibility, environment loading, fetch, streams, native file responses, subprocesses, SQLite prepared queries/transactions, WAL configuration, serialization/deserialization for test DBs, test preloads/mocks/fake time/parallel workers, frozen installs, lockfiles and minimum package release age.

Available without a current requirement: S3, Redis, PostgreSQL/MySQL through `Bun.SQL`, TCP/UDP, WebSockets/pub-sub, HTTP/2/3 tuning, FetchSession pool isolation, preconnect/DNS tuning, cookies/CSRF/password auth, OS secrets, Archive/compression, Workers, Cron, Terminal, WebView, HTMLRewriter, TOML/YAML/JSON5/XML parsers, semver/color/terminal-width helpers, FFI/C/Node-API/Bindgen, macros/runtime plugins/ModuleGraph, standalone executables/bytecode, workspaces/catalogs/publishing, dependency patching/overrides/registry infrastructure, test coverage/DOM/snapshots, alternate deployment adapters and scaffolding commands. These add machinery unless a caller actually needs their semantics. The linked capability catalog supplies the source map.

SQLite UDFs/aggregates and row hooks exist locally. A JS UDF is not automatically faster than JS outside SQL, and row hooks do not replace publishing domain changes after a transaction commits. No `Database.backupTo` exists in the local runtime; SQLite `VACUUM INTO` is a separate option, and an installation backup also needs artifact files and the encryption key.

## Verification

This pass confirmed Bun 1.4.4, manifest/Docker pins, installed declaration versions, formatter availability, run/test CLI flags, the built-in checker's three diagnostics, SHA-256 equality for four input categories, JSONL valid-prefix behavior, and local presence of Image, FetchSession, SQLite function/aggregate, and ArrayBufferSink APIs. Database probes used an empty in-memory database.

- `bun run typecheck`: passed with the configured TypeScript 7 compiler.
- `bun check --no-script --noEmit`: failed with the three `TS2589` diagnostics listed above.
- `bun --bun run build`: passed, including the host and built-in Box clients. The Vite process executable resolved to the installed Bun binary. Vite emitted warnings about extensionless config imports and large chunks. This establishes build compatibility, not faster builds or correct development HMR/browser behavior. Generated `dist/` output was rebuilt.
- `bun fmt --doctor`, `bun run --help`, `bun test --help`, and `bun pm --help`: inspected without modifying configuration, packages or caches.

No application source, manifests, lockfile, configuration, or persistent database was edited. The pre-existing research files were preserved. This is a capability-family audit and source comparison, not a certification of every Bun option or npm integration. The full application suite was not run.
