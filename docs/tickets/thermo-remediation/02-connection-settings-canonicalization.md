# Connection settings canonicalization

Status: TODO

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, findings F5, F8, and the connection-settings route portion of F7.

## Goal

Give connection snapshots, blank profile drafts, and connection-settings payload projections one canonical owner.

## Ownership

- `src/shared/contract/connection-settings.ts`
- `src/server/connection-settings/**`
- `src/client/connection-settings-state.ts`
- `src/server/contract/connection-settings.ts`
- `src/server/application/generation-coordinator.ts`
- `src/server/workflows/generate-capture.ts`
- Focused tests for these modules

Do not edit `src/server/workflows/generate.ts` or generation acceptance commands. Ticket 05 owns the lifecycle refactor.

## Work

- [ ] Add one canonical constructor for the persisted and runtime connection snapshot.
- [ ] Use that constructor in the generation coordinator and generation capture path.
- [ ] Put the canonical blank profile draft beside the shared connection-settings schema.
- [ ] Derive the client blank state and generic OpenAI-compatible preset from the canonical draft.
- [ ] Replace repeated field-by-field wire projections with one shared projection.
- [ ] Bind the connection-settings module once in the contract route instead of repeating `withConnectionSettings` wrappers.
- [ ] Remove replaced literals and helpers without compatibility layers.
- [ ] Run focused connection-settings and generation tests, typechecking, and the full test suite.
- [ ] Run `/code-review` with Luna XHigh review subagents and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- Runtime and capture provenance cannot construct different connection snapshots.
- Client initial state and the generic preset share one blank draft.
- Wire payload fields have one projection helper.
- The connection-settings route no longer repeats module connection boilerplate.

