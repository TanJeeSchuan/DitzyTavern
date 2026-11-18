# Box Exports

Status: TODO

Blocked By: none

Source: `docs/specs/character-drafter.md`, Implementation Decisions 1–3; ADR-0055.

## Goal

A built-in Box can declare read-only Exports, another built-in Box's routes can read them through `boxExports`, and Memory exports `people()` and `claimsAbout({ label })`.

## Ownership

- `src/shared/contract/box-descriptor.ts`, `src/server/box/contract.ts` and the Box loader
- `src/box-sdk/server.ts`
- `src/boxes/memory` (its descriptor and server Exports only)
- `docs/box-system/` (the contract summary and authoring docs)

## Work

- [ ] Add optional `exports: { [name]: { description, input, output } }` to the descriptor and `exports: { [name]: (input, { database, conversationId }) => output }` to the server Box. The loader refuses a Box whose two sides name different Exports, and a sandboxed Box that declares any.
- [ ] Add `boxExports(database, conversationId)` to the server SDK: every Box enabled in that Chat, each Export wrapped to check input and output against its schemas and to fail naming the Box, the Export and the path.
- [ ] Memory: `people()` returns the person labels on the Selected narrative path after label merges; `claimsAbout({ label })` returns the effective Claims on that path whose people include the label after merges, each with the Message that holds it.
- [ ] Document Exports in `docs/box-system/README.md` (contract and rules) and `authoring.md`, including that only route handlers may call `boxExports`.
- [ ] Tests: a disabled or absent provider is missing from `boxExports`; a provider output failing its schema fails naming Box, Export and path; Memory's Exports apply label merges, return a Writer override's Claims, and leave out Claims off the Selected narrative path.
- [ ] Run focused tests and lint on changed files; push and let CI run the rest.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No Box reads another Box's records or storage except through an Export.
- `boxExports` is not reachable from `advance`, digest or `fold` contexts.
