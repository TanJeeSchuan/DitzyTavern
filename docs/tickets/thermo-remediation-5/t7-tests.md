# T7: Tests

Status: READY

Blocked By: T6 (branch from T6's tip; T6's PR may still be open)

Model: Sol 6.2 high. Reviewer: Sonnet 5.5 high.

Test code only. No production file changes except where a slice names one. Evidence: reports 23, 24, 25 and 26. Read the new test rules in `CODING_STANDARDS.md` first.

Line numbers in the reports predate T1–T6. Find each test by name.

## Slice a: shared builders

- Server: `emptyPromptChannels()` from `src/shared/definition.ts` replaces the six-field prompt literal (74 test files at review time). Add to `src/server/test-fixtures/conversation.ts`: a Participant builder, a two-Participant Chat builder, and an accept helper for the acceptance input. Add a Connection Profile constant and one SSE reply helper to `src/server/contract/prompt-preset-test-fixtures.ts`. Delete the local copies. Reports 23 F1; 24 F1; 26 F1, F2, F9.
- Smaller shared pieces: a Lore entry builder (26 F22) and a "database at migration N" helper (26 F14).
- Client: a `src/client/test-fixtures/conversation.ts` with builders for a Conversation summary, a history page, a Message, a Variant, a Generation target, and `installFetch`. Report 25 F3.

The diff should remove setup and change no assertion.

## Slice b: contract tests

Report 24.

- Delete the tests that restate a domain test (F4's table), except the "other routes stay responsive" test in `resumable-generation.test.ts`, which stays.
- Move domain tests out of `src/server/contract/`: the preview store tests to a new `workflows/generation-preview.test.ts`, leaving the three that are about the wire (F2); `fork-conversation`, `box-traces` and `lore-activation-record` to `src/server/conversation/` (F3); the Author's Note mapping cases to the SillyTavern adapter tests (F10).
- Replace the unbounded `while (captured === undefined)` polls: `captureModelFetch` returns a promise that resolves when the request arrives (F5). This edits the fixture, not production code.

## Slice c: assertions that prove nothing, and leaked globals

- Assertions a wrong implementation passes: 23 F8; 24 F7; 25 F12; 26 F11 and F19. Strengthen or delete each as its report says.
- Globals a test sets and never restores, in a suite that runs without isolation: the `window` replacements and `document` installs (25 F15), `globalThis.host` in the Race UI test (26 F21), the Box registry restore written by hand where a fixture exists (24 F9). Restore in `afterEach`, or delete the override where the preload already provides it.
- `e2e/load-more-anchor.spec.ts` waits a fixed 1.5 s; poll for the condition (25 F16).

## Rejected

- Splitting the large e2e specs, trimming the Box lifecycle specs, and changing e2e selectors: not scheduled.
- Rewriting the client reducer tests: T8 does that with the code they test.
- Adding Playwright retries.

## TODO

- [ ] Slice a, PR
- [ ] Slice b, PR
- [ ] Slice c, PR

## Acceptance

`git grep -l 'postHistoryInstruction:' -- 'src/*.test.ts' | wc -l` is under 10. `git grep -n 'while (captured === undefined)' -- src` is empty. The unit suite passes in CI with the same count of tests minus those the slices delete; list the deleted tests in the Outcome.

## Outcome
