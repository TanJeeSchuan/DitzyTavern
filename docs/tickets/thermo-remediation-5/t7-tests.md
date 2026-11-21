# T7: Tests

Status: DONE

Blocked By: T6 (merged)

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

- [x] Slice a, PR
- [x] Slice b, PR
- [x] Slice c, PR

## Acceptance

`git grep -l 'postHistoryInstruction:' -- 'src/*.test.ts' | wc -l` is under 10. `git grep -n 'while (captured === undefined)' -- src` is empty. The unit suite passes in CI with the same count of tests minus those the slices delete; list the deleted tests in the Outcome.

## Outcome

- Slice a uses the shared prompt constructor and fixture builders for Participants, Chats, Generation acceptance, Connection Profiles, SSE replies, Lore entries, migration cutoffs, and client tests.
- The prompt field search went from 73 test files to nine. No tests or assertions were removed or changed. A static comparison against the base checked 999 test declarations and 3,442 assertions in the edited tests.
- Changed-file lint and `git diff --check` passed. GitHub Actions runs the test suites and typecheck.
- Migration tests stage their journals under `.scratch/`. The responsiveness test still drives a 20,000-event pull stream. Acceptance tests that exercise a historical Control pair construct their own capture.
- The first CI run caught two fixture caller types. The Generation runner now passes only the Generation ID to the target builder, and the Connection Settings test adapts fetch inputs to URL strings.

### Slice b

- The preview workflow suite exercises capture, acceptance, expiry and staleness directly. Three preview wire tests remain in the contract suite. Fork, Box trace and Lore Activation Record tests now live in Conversation, including the T6 assertion that a Fork preserves Generation Settings. Author's Note mapping cases now exercise the SillyTavern adapter, and the contract suite checks that warnings reach Import Details.
- Provider fakes resolve request-capture promises on arrival. Static searches found zero former capture polls and nine test files that declare `postHistoryInstruction`. Changed-file lint and `git diff --check` passed. The CI `check` job runs the unit suite and typecheck.
- A static comparison of test declarations and literal parameter tables found 14 fewer cases. The existing domain tests now check that parallel Siblings settle as separate Variants and that recovery preserves checkpointed text and is safe to rerun. The responsiveness test stays.
- The first CI run stalled while a rejection assertion waited on a held fake provider. The test now releases the provider before checking its result. The focused BuildBuddy run passed all 100 cases.

Deleted tests:

| File in `src/server/contract/` | Test |
|---|---|
| `send-generation.test.ts` | persists partial provider output as an interrupted Variant through the HTTP routes |
| `send-generation.test.ts` | zero output retries only on an explicit second start and never duplicates the human Message |
| `generation.test.ts` | persists the complete canonical settings the settings update command carries |
| `generation.test.ts` | streams a server-owned Sibling Generation on the target Message |
| `generation.test.ts` | runs parallel Sibling Generations as independent accepted outcomes |
| `continuation-generation.test.ts` | accepts Continue without a human Message and uses the instruction strategy |
| `resumable-generation.test.ts` | restart recovery exposes checkpointed output as a terminal interrupted Variant |
| `edited-plan-images.test.ts` | sends a copied Image unknown to the original preview once the edited plan is accepted |
| `prompt-preset-instruction-macros.test.ts` | an instruction save never overwrites separately saved ordering, toggles or roles |
| `contract.test.ts` | lists Characters in library order |
| `contract.test.ts` | applies commands, propagates revisions, and maps conflicts to the typed 409 payload |
| `contract.test.ts` | reads a Conversation summary with derived Cast and Control fields |
| `contract.test.ts` | maps removal of a seated Participant to the typed not-removable outcome |
| `contract.test.ts` | promotes a Participant with the applied outcome and the new Character payload |

### Slice c

- Tests now check the default Generation response budget, the loaded disabled Box, the Presets payload, attachment removal, and both sides of the edited Prompt Plan budget. Rejection assertions identify the failure they expect. The authoring example test compares libfx results against the actual source files.
- Client tests use the preloaded window. The hook and Race UI tests restore the globals they install, and the Box preload reloads built-ins after the temporary catalogs used by creation and Fork tests. The scroll test polls for its final position.
- The preview workflow test now checks the budget error type and observes the fitting edit reach the provider. The missing-history test checks that the refresh actually receives a 404 and still returns the Conversation. The current history observer separately reports a missing page to the story reducer.
- The redundant import Cast existence checks were already removed in `5405a297`. Changed-file lint and `git diff --check` pass. FFF finds nine test files with `postHistoryInstruction:` and zero former capture polls. The previous green CI run passed 1,912 unit cases. With the three removals, this slice expects 1,909.
- The first CI run caught two test types. Malformed preview cases now keep their literal target shapes, and the settings test checks that the original read exists before comparing it.
- The next run showed that libfx's tool-end event previews only the first 200 characters. The authoring test now checks the full result in the model's next request.

Deleted tests:

| File | Test |
|---|---|
| `src/server/contract/route-schemas.test.ts` | Elysia mirrors every route schema without falling back |
| `src/server/conversation/chat-summaries.test.ts` | a Chat without Participants has no Portraits |
| `src/shared/model-identifier.test.ts` | returns 0 for identical strings |
