# Four process-local registries, four lifecycles

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F5.

## Goal

Replace the four scattered process-local registries (generation runtime, generation previews, in-flight memory work, staged import sessions) with one per-database container owning one sweep tick and one dispose path, so graceful shutdown tears every process-local store down through one seam.

## Mechanics

**Machinery removed**

- `workflows/generation-preview.ts`: the per-database `WeakMap` singleton lookup, the store's own `setInterval` sweep, and the `clearGenerationPreviewRegistry` reset export. The store's maps and sweep behavior remain behind an exported `createGenerationPreviewStore()` factory.
- `sillytavern/staged.ts`: the module-level session `Map` (now per database), the lazily started `setInterval` sweep, and both the `sweepExpiredImportSessions` and `clearStagedImportRegistry` module exports. The expiry sweep (including staged-file deletion) remains behind an exported `createStagedImportStore()` factory.
- `workflows/generation-runtime.ts`: the module-level `WeakMap` singleton lookup and the registry's precise scheduled-cleanup timer (`GenerationRuntimeScheduleHandle`, the `schedule`/`cancel` scheduler seam, `cleanupHandle`, `scheduleCleanup()`) — it duplicated the container's tick. Also the now-unreachable `GenerationRuntime.onTerminal` constructor callback, which only that timer's wiring used. `cleanup(now)` (driven lazily on registry access and by the tick) and `drain()` semantics are unchanged; the persisted expiry boundary in Conversation independently enforces the same retention.
- All three timer mechanisms and three reset exports are gone; no alias was kept.

**Machinery introduced**

- `application/process-state.ts` — `processStateFor(database)`: one container per database (`WeakMap`-keyed, so in-memory test databases with reused integer IDs never share state) holding `generationRuntimes` (`GenerationRuntimeRegistry`), `generationPreviews` (`GenerationPreviewStore`), `memoryWork` (in-flight memory work by variant id), and `stagedImports` (`StagedImportStore`), plus:
  - one unref'd 60 s sweep tick per container: `generationRuntimes.cleanup(now)`, `generationPreviews.sweep(now)`, `stagedImports.sweep(now)`. Memory work is not swept (no expiry semantics — registration/unregistration only).
  - one `dispose()`: stops the tick, clears all stores, forgets the container.
- `application/shutdown.ts` calls `processStateFor(database).dispose()` after the graceful generation drain and before closing the database — the single dispose path.
- Domain store behavior stays in the domain modules (sweep logic, including staged-file deletion, lives in their factories); the container owns only lifecycle: creation, ticking, teardown.

**Behavior change (documented, the one for this ticket)**

Graceful shutdown now drops inspection previews and staged import sessions in the still-running process (`dispose()`), matching the restart contract both modules already document ("a server restart clears it wholesale" / "Refresh it after a server restart"). Previously the drop happened only because the process exited. Memory's in-flight work registry keeps its exact API (`registerMemoryWork`/`abortMemoryWork`); only its backing store moved into the container. No other provider-visible or wire-visible behavior changed.

## Verification

- `bun run check` (lint, lint:rules, check:contracts, typecheck, typecheck:tools, test, test:e2e:harness) — exit 0.
- `bun test src` — 1305 pass / 0 fail.
- `rg -n 'setInterval' src/server/workflows/ src/server/sillytavern/ src/server/memory/ | rg -v test` — 0 matches; the one tick lives in `application/process-state.ts`.
- `rg -n 'clearGenerationPreviewRegistry|clearStagedImportRegistry' src/` — 0 matches.
- No production file ≥ 1,000 lines (largest: `database/schema.ts` 918).
- `bun run test:e2e` — green except `updates.spec.ts:55`, which fails identically on the unmodified baseline under full-suite parallel load and passes 3/3 in isolation (pre-existing flake, unrelated to this change). All shutdown/recovery/crash specs stay green.

## Residual (accepted)

- Terminal replay state can now expire up to one sweep tick (~60 s) past its retention boundary when the process is fully idle; the persisted `expires_at` boundary in Conversation already enforces the same retention for reads, so the bounded-window contract holds.
- Orphaned staged files of evicted sessions on a real restart remain an accepted lifecycle tradeoff (no GC), unchanged from before.
