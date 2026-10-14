# Long-history e2e specs fit their budget

Status: TODO

Blocked By: none

Source: PR B verification. In full `bun run test:e2e` runs on the 7 GB host, `e2e/story-jump.spec.ts` and `e2e/story-sync.spec.ts` sometimes hit Playwright's 30 s test timeout (37.6 s and 32.9 s in one run). Alone they pass in 9–23 s, and they take the same time on `feat/box-core`, so the cause predates the Box plugin work.

## Goal

Both specs pass reliably in a full parallel run, without raising the global timeout.

## Decisions

- The likely cost is setup, not the behavior under test: each spec builds its history through one HTTP `create-message` command per Message (up to 225 in `story-jump`, 75 in `story-sync`), each waiting for the previous revision. Measure first: time the setup loop against the rest of the test under full-suite load before changing anything.
- If setup dominates, build the history in one step: a single command or e2e-server helper that inserts many Messages at once. Prefer a helper in `e2e/server.ts` or the `llm` fixture over a new public API route; e2e setup must not grow the product's API.
- A per-test `test.slow()` or a larger timeout only hides the cost. Use it only if measurement shows the user-flow part itself is slow, and say why in the spec.

## Work

- [ ] Measure setup versus test time for both specs in a full run.
- [ ] Replace the per-Message setup loop (or justify the alternative).
- [ ] Run the full `bun run test:e2e` three times; both specs pass every time.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Three consecutive full e2e runs pass with no retries.
