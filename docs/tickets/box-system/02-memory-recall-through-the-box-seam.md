# Memory recall through the Box seam

Status: DONE

Blocked By: 01-author-note-becomes-the-first-box

Source: `docs/box-system/README.md` "The contract", "Generation lifecycle" steps 2–4, "Built-in Boxes" (Memory); ADR-0042, ADR-0050; full port deferred to GitHub #68.

## Goal

Memory recall runs as the Memory Box's async `advance`, in parallel with other Boxes, through a `box:memory` block. Memory behaves exactly as it does today.

## Ownership

- Memory recall and its Prompt Plan admission
- Box `advance` traces and fingerprints
- Preview staleness

## Work

- [x] Add the async `advance` with injected services (`llm`, `decide`, `embed`), the `trace` result, `fingerprint`, and the `allowance` item budget to the contract.
- [x] Recall becomes the Memory Box's `advance`. Claims become prioritized unpinned items under the Memory allowance. The `MemoryActivationRecord` becomes its trace, held on the Active Generation and retained with the Variant.
- [x] The host fingerprints captured Box inputs. Memory's freshness fingerprint feeds the Box fingerprint, and a mismatch still reports the plan as stale.
- [x] Migrate `memory` preset blocks to `box:memory`, and drop the `memory` reference and its index.
- [x] `memory_collection`, the Memory settings tables and the extraction queue stay as they are.
- [x] Existing Memory unit tests and e2e pass unchanged, apart from the block reference.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Recall failure still stops preparation with "Memory recall failed".
- An edited Memory Block in inspection is still sent as edited and bounded by the allowance.
- Generation details still show the Memory activation evidence for a resolved Variant.

## Verification

- `bun run check`: passed, including 1,435 unit/contract tests and three e2e-harness tests.
- Both full `bun run test:e2e --workers=1` runs passed 37/38 tests. The truncated-stream provider test intermittently renders duplicated partial text; the identical failure reproduced on the pre-ticket commit `744d19f1` with `bun run test:e2e e2e/provider-faults.spec.ts --workers=1 --repeat-each=10 --max-failures=1`. Both Memory e2e tests passed.
- Sequential standards and spec/correctness reviews by `gpt-6.1-sol` at high reasoning found no remaining issues, including verification of the Box macro-order fix.
