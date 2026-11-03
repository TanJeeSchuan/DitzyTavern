# Mood as a sandboxed Box

Status: TODO

Blocked By: 02

Source: `docs/research/sandbox-box-landmark-fit.md` (Decision rows of the Memory inventory; cancellation), `docs/research/sandboxed-box-spike.md` (Promise bridge and cancellation), `src/boxes/mood`.

## Goal

Sandboxed Boxes can digest settled prose and ask their Decision Model questions through `decide`. Mood, rewritten as a sandboxed Box, passes `src/boxes/mood/mood.spec.ts` with unchanged story assertions. The trusted Mood is removed.

This is what lets Creator Mode build Boxes that track prose (mood, relationships, time passing in the story), not only ones driven by writer Moves.

## Ownership

- `src/server/box` (the adapter's digest path and the `decide` bridge)
- `src/boxes/mood`
- `docs/box-system/README.md`

## Design decisions already made

- Only `decide`, and only inside `digest`. The host injects it into the digest call and nowhere else. `complete` and `embed` stay deferred to the Memory capability work in #69, because they take arbitrary prompts and outputs and need grants and budgets.
- The descriptor's `decision` block keeps the host in charge of choosing the Decision Model. The guest never sees a profile id.
- Spending needs no per-Box budget: the digest queue calls `digest` at most once per settled passage per Box.
- `decide` resolves to answer entries (`[key, DecisionAnswer][]`), not a `Map`.
- Mood's window is the host's `digestWindow`, declared in `descriptor.json`. It needs no frame.

## Work

- [ ] Adapter: `records.digest` with `window` and an async `run` through the Promise bridge. The host supplies the passage, preceding passages and the other digest inputs it supplies today.
- [ ] `decide(state, questions)`: uses the Box's resolved Decision selection, request packing and token limits exactly as the trusted path does.
- [ ] Cancellation: when the digest queue supersedes or drops a job (a newer passage, a Swipe, the Box disabled or removed), outstanding `decide` promises reject in the guest, the host aborts the request, and late answers are dropped. A cancelled job writes nothing.
- [ ] Errors: a guest throw or a refused answer lands as a digest error, as it does for trusted Boxes.
- [ ] `descriptor.json`: the `decision` block, a digest window (`{ kind: "digest", icon, size }`, with `icon` from a fixed list of icon names), and a sync `status` hook in `logic.js`.
- [ ] Rewrite Mood as `descriptor.json` + `logic.js` and delete its trusted files. Stored Mood records stay valid; the record schema does not change.
- [ ] `mood.spec.ts` passes with its story assertions unchanged.
- [ ] Contract tests: a digest whose `decide` is pending when its job is superseded rejects in the guest and writes nothing; calling `decide` from `advance` or `fold` fails because it is not defined there.
- [ ] Document the sandboxed digest path in `docs/box-system/README.md`.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Mood behaves as before: digested passages, a Swipe, a Writer override, an unclear passage and an override racing a landing digest.
- A sandboxed Box can reach a model only through `decide`, inside `digest`, using the model the writer chose.
