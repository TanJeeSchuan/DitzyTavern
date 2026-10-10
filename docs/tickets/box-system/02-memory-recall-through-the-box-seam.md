# Memory recall through the Box seam

Status: TODO

Blocked By: 01-author-note-becomes-the-first-box

Source: `docs/box-system/spec.md`, Implementation Decisions "Contract", "Generation lifecycle" steps 2–4, "Memory Box (seam port)"; ADR-0042, ADR-0050; full port deferred to GitHub #68.

## Goal

Memory recall runs as the Memory Box's async `advance`, in parallel with other Boxes, through a `box:memory` block. Memory behaves exactly as it does today.

## Ownership

- Memory recall and its Prompt Plan admission
- Box `advance` traces and fingerprints
- Preview staleness

## Work

- [ ] Add the async `advance` with injected services (`llm`, `decide`, `embed`), the `trace` result, `fingerprint`, and the `allowance` item budget to the contract.
- [ ] Recall becomes the Memory Box's `advance`. Claims become prioritized unpinned items under the Memory allowance. The `MemoryActivationRecord` becomes its trace, held on the Active Generation and retained with the Variant.
- [ ] The host fingerprints captured Box inputs. Memory's freshness fingerprint feeds the Box fingerprint, and a mismatch still reports the plan as stale.
- [ ] Migrate `memory` preset blocks to `box:memory`, and drop the `memory` reference and its index.
- [ ] `memory_collection`, the Memory settings tables and the extraction queue stay as they are.
- [ ] Existing Memory unit tests and e2e pass unchanged, apart from the block reference.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Recall failure still stops preparation with "Memory recall failed".
- An edited Memory Block in inspection is still sent as edited and bounded by the allowance.
- Generation details still show the Memory activation evidence for a resolved Variant.
