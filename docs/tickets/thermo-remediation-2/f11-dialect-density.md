# Two dialects in one server (density cleanup)

Status: DONE

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
- The one-liner dialect in the owned files: drizzle chains are broken onto
  lines, whole-expression object literals are extracted to locals, long
  multi-statement lines are one statement per line. (Deferred to the final
  conversion sweep: the `==[HUMAN APPROVED]==` markers in the owned files
  are intentionally NOT converted here.)

Introduced:

- In `memory/recall.ts` (private, no exports added): `readRecallInputs`,
  `scanMemorySources`, `assembleRecallActivation`, `readRecallFreshness`,
  plus the `RecallSceneInput`, `ReadRecallInputs`, `RecallSourceScan`,
  `RecallAssembly`, `UnprocessedRecallSource`, `ScannedRecallSource`
  record types and the `CollectionRow`/`RecallCandidateBase` aliases.
- In `client/workspace/`: `LorebookPanelEditors.tsx` (the match tester,
  entry editor, chat-lore settings/loading components — moved verbatim from
  the file bottom) and `lorebook-entry-fields.ts` (the `EntryListKey`
  vocabulary, field tables, and the newline list separator pair with its
  human-approved note). `LorebookPanel` keeps its name and export; the
  only external import site (`PrimaryPanelView.tsx`) is untouched.

Behavior: none. `captureMemoryRecallSnapshot`'s public signature, record
shape, and evaluation order are identical; LorebookPanel's DOM is unchanged.

## Work

- [x] Split `captureMemoryRecallSnapshot` into read / count / assemble.
- [x] Reformat `memory/recall.ts`, `memory/collections.ts`, `memory/extraction.ts`, `memory/sync.ts`, `memory/cancellation.ts`, `memory/work.ts`, `memory/labels.ts`, `memory/indexing.ts`, `memory/settings.ts`, `memory/index.ts`.
- [x] Reformat `lorebook/attachments.ts`.
- [x] Reformat `decision-model/index.ts`.
- [x] Reformat `client/workspace/LorebookPanel.tsx`.
- [x] Verification: typecheck, lint, tests, contracts, e2e; long-line scan; marker count unchanged; file-size guard.

## Acceptance

- No production file ≥ 1,000 lines after reformatting growth.
- `bun run check` (incl. e2e + harness) passes with zero fixture changes.
- `rg -n '.{240,}'` across the owned files returns only documented long-prose exceptions.
- `HUMAN APPROVED` marker count across `src` unchanged (1198 occurrences, same as base 1f5dbc7).

## Leftover risks (pre-existing, out of scope)

- `src/styles/story.css` is 1,232 lines on master (already over the guard at base 1f5dbc7); it is not part of this ticket's dialect list and was not touched. Needs routing to a styles owner.
- `extraction.ts`'s extracted-instruction template literal is a single ~1,200-character prose line; wrapping it would change the string value sent to the model, so it stays. Same class of exception for any long SQL/URL literals.
- One flaky restart-timing e2e (`updates.spec.ts:55`) failed once across four full-suite runs and passes in isolation and on retry; unrelated files.
