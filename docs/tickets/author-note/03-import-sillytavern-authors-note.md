# Import SillyTavern Author's Note

Status: DONE

Blocked By: 01-author-note-in-the-prompt-plan

Source: `docs/specs/author-note.md`, User Stories 32–37; Implementation Decision 12; ADR-0048.

## Goal

Importing a SillyTavern chat with an Author's Note produces a Chat whose Author Note holds that text, with Import Details warnings for every placement setting that could not be kept.

## Ownership

- SillyTavern chat decoder and Import Projection
- SillyTavern chat fixture

## Work

- [x] Read `chat_metadata.note_prompt`, map `{{user}}` to `{{self}}` and `{{char}}` to `{{other}}`, and write it as the Chat's Author Note at commit.
- [x] Warn when `note_position` is not 1 or `note_depth` is not 0, when `note_role` is not 0, and when `note_interval` is not 1. No note warnings when `note_prompt` is missing or empty.
- [x] Add the note fields to the existing SillyTavern fixture.
- [x] Contract tests through the chat import routes: note and macro mapping; each warning; quiet import without a note.
- [x] Run focused tests, typechecking, and the full test suite.
- [ ] Run `/code-review` and resolve its findings. (Skipped as instructed; branch-wide review follows.)
- [x] Set this ticket to DONE and commit the implementation.

## Acceptance

- Importing `.sample-format/chat/rescue-1787938574084.jsonl` yields its note text and one placement warning (position 2).

## Implementation Notes

- The sample JSONL is absent from the supplied checkout. Contract tests cover its documented position 2 / depth 4 combination and assert exactly one placement warning.
- Validation: 109 focused tests; `bun run check` (1,268 tests); `bun run test:e2e` (24 tests). The first E2E run timed out waiting for a memory-flow send; the full rerun passed without changes.
