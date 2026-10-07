# Author Note slot in existing presets

Status: TODO

Blocked By: 01-author-note-in-the-prompt-plan

Source: `docs/specs/author-note.md`, User Stories 26, 27, 30, 31; Implementation Decisions 4, 9, 11; ADR-0041, ADR-0048.

## Goal

A writer whose Chat uses an older preset sees that the note is inactive, adds the slot with one action, and can share the preset through native JSON without losing the slot.

## Ownership

- Prompt Preset library commands (Add Author Note Block)
- Author Note panel inactive explanation
- Native preset JSON export and import

## Work

- [ ] Add the Add Author Note Block preset command, placing the slot directly after the last history slot, or at the end when the recipe has no history.
- [ ] In the Author Note panel, explain when the note is non-blank but the preset has no enabled slot, and offer add or enable.
- [ ] Carry the slot through native preset export and import; reject imports with more than one occurrence, disabled or not.
- [ ] Contract tests: add action on a preset without the slot; add action refused when one exists; export/import round trip keeps position, role and enablement; duplicate rejection.
- [ ] Verify the inactive explanation manually with playwright-cli. No UI tests.
- [ ] Run focused tests, typechecking, and the full test suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- Existing stored presets are unchanged until the writer adds the slot.
