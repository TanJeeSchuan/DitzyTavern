# Small direct deletions

Status: TODO

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, findings F9, F10, F13, and F14.

## Goal

Delete four small pieces of restatement or unnecessary type coercion without changing behavior.

## Ownership

- `src/server/conversation/commands/active-generation.ts`
- `src/server/conversation/commands/transaction.ts`
- `src/client/App.tsx`
- `src/client/import-chat-flow.ts`
- Focused tests for these paths

## Work

- [ ] Build terminal replay inspection from the active row plus terminal overrides instead of copying every common column.
- [ ] Give the plain and guarded revision advances one shared set-clause builder.
- [ ] Pass `initialWorkspace` directly in `App.tsx`.
- [ ] Replace the import flow's array cast and safety comment with an `.at(-1)` undefined guard.
- [ ] Add no architectural regression tests for these mechanical simplifications.
- [ ] Run focused tests, typechecking, and the full test suite.
- [ ] Run `/code-review` with Luna XHigh review subagents and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- The four reported duplicates or coercions are gone.
- Existing behavior and error ordering remain unchanged.
- No fallback or compatibility path is added.

