# Box Exports

Status: DONE

Blocked By: none

Source: `docs/specs/character-drafter.md`, Implementation Decisions 1–3; ADR-0055.

## Goal

A built-in Box can declare read-only Exports, another built-in Box's route handlers can read them through the `exportsOf(conversationId)` the host hands its `routes(database, exportsOf)`, and Memory exports `people()` and `selectedClaims()`.

## Ownership

- `src/shared/contract/box-descriptor.ts`, `src/server/box/contract.ts` and the Box loader
- `src/box-sdk/server.ts`
- `src/boxes/memory` (its descriptor and server Exports only)
- `docs/box-system/` (the contract summary and authoring docs)

## Work

- [x] Add the descriptor and server Export declarations. [The Box contract](../../box-system/README.md#the-contract)
- [x] Implement `boxExports` and pass `exportsOf` to Box routes. [The Box rules](../../box-system/README.md#the-rules)
- [x] Add the Memory Exports. `people()` returns resolved labels on the Selected narrative path. `selectedClaims()` returns the effective Claims on that path with their resolved people and source Messages.
- [x] Document Exports in `docs/box-system/README.md` (contract and rules) and `authoring.md`, including that only route handlers hold `exportsOf`.
- [x] Tests: a disabled or absent provider is missing from `exportsOf`'s answer; a provider output failing its schema fails naming Box, Export and path; Memory's Exports apply label merges, return a Writer override's Claims, and leave out Claims off the Selected narrative path.
- [x] Run focused tests and lint on changed files; push and let CI run the rest.
- [x] Set this ticket to DONE and commit.

## Acceptance

See the Export access rules. [The Box rules](../../box-system/README.md#the-rules)
