# Two dialects in one server (density cleanup)

Status: IN PROGRESS

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F11 (conversion portion deferred to the post-merge sweep).

## Goal

One code dialect in the remediated area: `captureMemoryRecallSnapshot`'s
~85-line body assembling a ~25-field record in one literal is split into
read / count / assemble seams, and the 240+-character one-liner dialect in
`src/server/memory/*`, `src/server/lorebook/attachments.ts`,
`src/server/decision-model/index.ts`, and
`src/client/workspace/LorebookPanel.tsx` is reformatted to the repo's
statement-per-line, ~100-column style. Purely mechanical — no logic moves,
no renames, no behavior change, no marker conversion.

## Ownership

- `src/server/memory/**`
- `src/server/lorebook/attachments.ts` (formatting only)
- `src/server/decision-model/index.ts`
- `src/client/workspace/LorebookPanel.tsx` (formatting only)
- `src/server/conversation/generation-details.ts` is F4's territory and untouched.

## Mechanics

Removed:

- The 85-line `captureMemoryRecallSnapshot` assembler: read / scan-count /
  assemble now live in separate seam functions.
- (Deferred to the final conversion sweep: the `==[HUMAN APPROVED]==`
  markers in the owned files are intentionally NOT converted here.)

Introduced:

- `readRecallInputs` / `scanMemorySources` / `assembleRecallActivation`
  (plus two local readonly record types) in `memory/recall.ts`; private,
  no exports added.

Behavior: none.

## Work

- [ ] Split `captureMemoryRecallSnapshot` into read / count / assemble.
- [ ] Reformat `memory/recall.ts`, `memory/collections.ts`, `memory/extraction.ts`, `memory/sync.ts`, `memory/cancellation.ts`.
- [ ] Reformat `lorebook/attachments.ts`.
- [ ] Reformat `decision-model/index.ts`.
- [ ] Reformat `client/workspace/LorebookPanel.tsx`.
- [ ] Verification: typecheck, lint, tests, contracts, e2e; long-line scan; marker count unchanged; file-size guard.

## Acceptance

- No production file ≥ 1,000 lines after reformatting growth.
- `bun run check` (incl. e2e + harness) passes with zero fixture changes.
- `rg -n '.{240,}'` across the owned files returns only documented long SQL/URL exceptions.
- `HUMAN APPROVED` marker count across `src` unchanged.

## Leftover risks

- None known; long string literals (SQL, instruction prose) stay single-line where wrapping would change their value.
