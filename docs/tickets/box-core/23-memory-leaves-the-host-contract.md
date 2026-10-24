# Memory leaves the host contract

Status: DONE

Blocked By: 22-memory-extraction-becomes-a-digest

Source: GitHub #68 (closing it). Memory is the only Box with its own hooks in the host contract and its own exports in the Box SDK. #72 turns the SDK into a public plugin surface, so anything Memory-specific left in it becomes plugin API.

## Goal

The Box contract and the Box SDK name no Box. Memory's server code lives in `src/boxes/memory/` and imports only `src/box-sdk/{shared,server}`, like every other Box.

## Decisions

- **`withoutBlock` is removed.** **Behavior change:** with its preset block disabled, Memory does not run, and inspection shows no activation for that Generation.
- **`trace` stays generic.** The host persists every Box's trace keyed by Box reference. Prompt Plan budget evidence is computed by the host for every Box from admission, not by reading `box:memory` in `src/server/generation-plan/compiler.ts`. `memory_activation_json` becomes the generic per-Box trace column. Memory's activation view reads Memory's trace.
- **`fingerprint` stays.** It is generic already.
- `CaptureRead.memory()`, `MemoryRecall`, `memoryActivationRecord` and `renderMemoryClaim` leave `src/server/box/contract.ts` and `src/box-sdk/server.ts`. Memory's dependencies come from generic reads, and its recall, rendering and extraction move from `src/server/memory/` into `src/boxes/memory/`.
- If Memory needs a primitive the SDK lacks, add the generic primitive to the SDK (named for what it does, not for Memory). Never re-export Memory code through it.
- The in-tree Memory client UI (`src/client/workspace/Memories*`, settings editor) stays where it is. Moving it is GitHub #24. Host client files that read Memory's trace or block by literal `box:memory` read it through the Box id instead.

## Work

- [x] Remove `withoutBlock` from the contract, the registry and `docs/box-system/README.md`.
- [x] Persist traces per Box, compute budget evidence generically, and rename the column.
- [x] Move Memory's server domain into `src/boxes/memory/` and remove Memory exports from the SDK and the contract.
- [x] Remove `"memory"` and `"box:memory"` literals from host server files (`compiler.ts`, `generation-preview.ts`, `prompt-preset.ts` and the ones listed by `rg '"(box:)?memory"' src/server src/shared`).
- [x] Run `bun run check` and the full `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- `src/server/box/contract.ts` and `src/box-sdk/` contain no Box name.
- `src/server/memory/` is gone, and `ditzy(no-box-boundary-imports)` passes with no new allowlist entries.
- Memory e2e behavior matches ticket 22, apart from the `withoutBlock` change.
