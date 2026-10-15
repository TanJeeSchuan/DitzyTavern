# Long-history e2e specs fit their budget

Status: DONE

Blocked By: none

Source: PR B verification. In full `bun run test:e2e` runs on the 7 GB host, `e2e/story-jump.spec.ts` and `e2e/story-sync.spec.ts` sometimes hit Playwright's 30 s test timeout (37.6 s and 32.9 s in one run). Alone they pass in 9–23 s, and they take the same time on `feat/box-core`, so the cause predates the Box plugin work.

## Goal

Both specs pass reliably in a full parallel run, without raising the global timeout.

## Decisions

- The likely cost is setup, not the behavior under test: each spec builds its history through one HTTP `create-message` command per Message (up to 225 in `story-jump`, 75 in `story-sync`), each waiting for the previous revision. Measure first: time the setup loop against the rest of the test under full-suite load before changing anything.
- If setup dominates, build the history in one step: a single command or e2e-server helper that inserts many Messages at once. Prefer a helper in `e2e/server.ts` or the `llm` fixture over a new public API route; e2e setup must not grow the product's API.
- A per-test `test.slow()` or a larger timeout only hides the cost. Use it only if measurement shows the user-flow part itself is slow, and say why in the spec.

## Work

- [x] Measure setup versus test time for both specs in a full run.
- [x] Replace the per-Message setup loop (or justify the alternative).
- [x] Run the full `bun run test:e2e` three times; both specs pass every time.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Three consecutive full e2e runs pass with no retries.

## Measurements and implementation

The full 84-test baseline passed with two workers in 2.9 minutes. `story-jump` spent 1.41 s in HTTP setup and 18.98 s in the remaining test body (22.2 s including fixtures). `story-sync` spent 0.59 s in setup and 18.67 s in the remaining body (19.4 s including fixtures). Setup accounts for only 7% and 3%, respectively.

Keep the setup loop: a batch endpoint would add machinery without addressing the dominant cost. Mark only the measured cross-tab flow in `story-sync` as `test.slow()`; the global 30 s timeout stays unchanged. The jump test reaches Message 50 through four existing PageDown steps and five arrows, preserving keyboard navigation coverage with nine steps instead of 49. The first updated full run brought `story-jump` down to 6.4 s, so it keeps the ordinary 30 s budget. No product API or fixture endpoint is added.

A subsequent full run reached 83/84; its unrelated recovery failure occurred before Send because the shared helper asserted editor readiness within 5 s. Remove that redundant attribute assertion: Playwright `fill()` already waits for visibility and editability within the unchanged test budget. This preserves the user action while removing a separate, shorter readiness deadline.

The complete-run requirement also exposed a reproducible Thoughts spec failure after a Swipe: the reading surface can scroll away from its bottom and recede the composer, hiding the Boxes button. The spec now returns the reading surface to its bottom before opening Boxes; it does not change composer behavior or bypass visibility checks.

## Final validation

Three consecutive full `bun run test:e2e` runs passed all 84 tests, with two workers and no retries: 2.3 min, 2.4 min, 2.3 min. `story-jump` took 6.1/6.3/6.3 s; `story-sync` took 5.8/6.1/6.5 s. The focused Thoughts test passed three consecutive repetitions after its scroll correction.
