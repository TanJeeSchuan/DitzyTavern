# Box delegates

Status: TODO

Blocked By: 05 (the stack through PR #211)

Source: the 2026-11-06 discussion of letting the writer model change a Box, using a 3D scene Box as the test case.

## Goal

The story model changes a Box by writing a plain-text request in its prose, such as `<scene>put the lantern on the table</scene>`. Once the passage settles, a small libfx agent, the Box's **delegate**, turns that request into the Box's own Moves, and the Box turns them into the passage's record. The story model needs no tool calls, every backend works, and the delegate can do nothing a writer clicking the Box's window couldn't.

The story model sees the result on its next turn, through the Box's prompt items. A query and its answer within one turn is out of scope.

## Ownership

- `src/server/box` (the delegate job in the digest queue, its settings, the record and error writes, the host lens's server half)
- `src/server/authoring/provider.ts` (reused for the delegate's model)
- `src/shared/contract` (descriptor `delegate`, the hook, settings, scenario scripting)
- `src/client` (the host lens for the tag, the failure notice, the settings editor)
- `src/server/authoring` (`contract.md`, `run_scenario`)

## Design decisions already made

- **Declared in the descriptor.** `delegate: { tag, summary, description, off }`. `tag` is the element name the story model writes. The other three strings word the Box's delegate setting, as `decision`'s do. The Box's own `instructions` teach the model to use the tag; the host adds nothing to the prompt.
- **Moves are the delegate's operations.** A delegating Box must declare `moves`. The delegate has exactly two tools:
  - `read()` returns the Box's current state as `read` would give the window;
  - `apply(moves)` checks the Moves against `moves.schema` and `moves.max`, as staged Moves are checked, and records them for this passage.

  It has no other tools, no files and no network.
- **The Box turns the Moves into the record** through a new hook, `delegate.apply({ setup, state, moves, cast }) → record`, which may be async. A passage with no tag, or whose delegate applied no Moves, gets a record that changes nothing, as a digest does for a passage it skips.
- **It runs in the digest queue.** A delegate run is a job in the existing queue: at most two workers, one current job per Variant and Box, only the current job's result lands, on the job's instance and version, and only while the Variant still holds the text it read. A failure writes the slot's error, as a digest failure does. Catch-up queues passages without a record and retries failed ones. A Box declares `delegate` or `decision`, never both, so a passage has one automatic record.
- **Its own model, through libfx.** The delegate is a libfx agent (`createFxAgent`, Wasm backend, `memory()` durability), mapped from a Chat Completions Connection Profile by `libfxProvider`, as Creator Mode's coding agent is. Each delegating Box has a host-stored setting, connection profile and model, kept in `library_data` under its own `box-delegate` namespace like `box-decision`, edited in Connection Settings beside the Decision Model settings. With no selection the delegate is off: jobs don't run, and the window says so.
- **A step cap per run.** Model requests and tool calls each count, 10 in all. Past it, the run fails with that reason.
- **Failure is shown by the host.** A delegating Box keeps its own window and `read`. The host draws a notice at the top of the window, like the block notice: "The delegate failed on Message N: <reason>", with **Retry**, which queues that passage again. Writer overrides (`set-box-record`) work as for any Box with a record.
- **The tag stays in the prompt and leaves the story view.** The host provides a lens for `delegate.tag` for any delegating Box, sandboxed ones included, which have no client module of their own. It lifts each `<tag>…</tag>` into a mark that opens the Box's window, and the prompt keeps the markup, so the model remembers what it asked for.
- **Scenarios script the delegate.** A `run_scenario` turn gains `delegated?: moves[]`: the Moves the delegate would apply for that turn's prose. The scenario checks them against the Move schema and runs `delegate.apply`, so a scenario still makes no model calls. A turn whose prose holds the tag but scripts no `delegated` reads as a delegate that applied nothing.

## Work

- [ ] Contract: `delegate` in the descriptor schema (sandboxed and trusted); refuse a Box declaring `delegate` without `moves`, or with `decision`; the `delegate.apply` hook in the server contract and the sandboxed adapter.
- [ ] Settings: the `box-delegate` selection (read, apply with revision, routes), and its editor in Connection Settings beside Decision Model settings.
- [ ] The delegate job: extract the tags from the settled passage, run the libfx agent with `read` and `apply` under the step cap, call `delegate.apply`, and write the record or the error through the digest queue's landing rules. Queue it where digests are queued (settle, resolve, edit, catch-up).
- [ ] The host lens for `delegate.tag`, and the failure notice with Retry in the Box's window.
- [ ] `run_scenario`: `delegated` per turn; `contract.md` documents `delegate`, the hook, the two tools and `delegated`.
- [ ] Tests, each failing before its code: a passage with the tag runs the delegate once and lands its record; the same passage without the tag lands a record that changes nothing; Moves outside `moves.schema` or past `max` are refused by `apply` and the run fails with that reason; a run past 10 steps fails; an edit while the run is in flight drops its result; a Box with both `delegate` and `decision` is refused; with no selection, nothing runs. The delegate's model is a localhost fake, as in the authoring tests.
- [ ] e2e: a sandboxed Box with `delegate` and a window; the story model's scripted reply holds the tag; the story view shows the lifted mark; the scripted delegate calls `apply`; the window shows the new state; the next Generation's Prompt Plan has the Box's item for it.
- [ ] README: the delegate section, linked from the contract, `decision` and the digest queue sections.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.

## Acceptance

- The story model changes a Box only through the Box's own Moves, checked as a writer's are.
- A delegate run lands at most one record per passage, under the same rules as a digest's.
- A scenario of a delegating Box makes no model calls.

## Out of scope

- Tool calls in the story model's own Generation, and a query answered within the same turn.
- Images of the Box in the prompt.
- A Box that both digests and delegates.
