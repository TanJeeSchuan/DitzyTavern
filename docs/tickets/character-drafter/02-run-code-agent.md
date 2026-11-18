# Code agent for Boxes

Status: TODO

Blocked By: none

Source: `docs/specs/character-drafter.md`, Implementation Decision 4.

## Goal

A built-in Box can run a libfx agent that explores frozen globals by writing JavaScript in a QuickJS sandbox and ends by submitting a schema-checked result.

## Ownership

- `src/server/box/` (a new code-agent module beside `delegate.ts`)
- `src/box-sdk/server.ts`
- `e2e/server.ts` authoring fake, only if the agent needs something it lacks

## Work

- [ ] Add `runCodeAgent({ boxId, instructions, globals, submitSchema, verify, signal, onActivity })`, model from `resolveBoxDelegate(boxId)`; refuse with the reason when it is off or broken.
- [ ] `run(code)`: one QuickJS context per run with `globals` frozen, 128 MiB heap, 2 s per call; return logged output plus the returned value as JSON, cut off at 8 KiB with a notice to narrow the query. Reuse the sandboxed-Box QuickJS setup rather than starting a second one.
- [ ] `submit(draft)`: schema check, then `verify`; either failure returns a libfx tool error; the first valid submit ends the run and is its result.
- [ ] 24 steps per run, counting model requests and tool calls, as `delegate.ts` counts them. Dispose of the context on success, failure and cancel.
- [ ] `onActivity` gets each `run` as a one-line summary with its code and output. Tool descriptions carry a `.d.ts` built from the globals' schemas.
- [ ] Tests through the authoring fake: a global set in one `run` is there in the next; heap and time limits fail with their reasons; output past 8 KiB is cut off; an invalid submit returns a tool error and a later valid one ends the run; the step cap fails the run; cancelling disposes of the context.
- [ ] Document it in `docs/box-system/authoring.md`.
- [ ] Run focused tests and lint on changed files; push and let CI run the rest.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Guest code reaches nothing but its globals: no network, filesystem, clock or host objects.
- A failed or cancelled run leaves no QuickJS context behind.
