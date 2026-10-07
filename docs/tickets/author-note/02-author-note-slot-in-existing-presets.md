# Author Note slot in existing presets

Status: DONE

Blocked By: 01-author-note-in-the-prompt-plan

Source: `docs/specs/author-note.md`, User Stories 26, 27, 30, 31; Implementation Decisions 4, 9, 11; ADR-0041, ADR-0048.

## Goal

A writer whose Chat uses an older preset sees that the note is inactive, adds the slot with one action, and can share the preset through native JSON without losing the slot.

## Ownership

- Prompt Preset library commands (Add Author Note Block)
- Author Note panel inactive explanation
- Native preset JSON export and import

## Work

- [x] Add the Add Author Note Block preset command, placing the slot directly after the last history slot, or at the end when the recipe has no history.
- [x] In the Author Note panel, explain when the note is non-blank but the preset has no enabled slot, and offer add or enable.
- [x] Carry the slot through native preset export and import; reject imports with more than one occurrence, disabled or not.
- [x] Contract tests: add action on a preset without the slot; add action refused when one exists; export/import round trip keeps position, role and enablement; duplicate rejection.
- [x] Verify the inactive explanation manually with playwright-cli. No UI tests.
- [x] Run focused tests, typechecking, and the full test suite.
- [x] Skip `/code-review` as instructed; branch-wide review follows later.
- [x] Set this ticket to DONE and commit the implementation.

## Acceptance

- Existing stored presets are unchanged until the writer adds the slot.


## Validation

- `bun run check`: passed (1,262 tests, 50 lint rule tests, 3 e2e harness tests).
- `bun run test:e2e`: 24 passed.
- Manual `playwright-cli`: blank note stays quiet; a saved note on an older recipe offers Add Author Note Block; a disabled slot offers Enable Author Note Block. Both actions remove the inactive explanation and retain the note.
- Native interchange and duplicate validation already shipped with ticket 01; this ticket verifies them through the HTTP contract.
