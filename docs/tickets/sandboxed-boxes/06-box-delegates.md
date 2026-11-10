# Box delegates

Status: Done

Blocked By: 05 (the stack through PR #211)

Source: the 2026-11-06 discussion of letting the writer model change a Box, with a 3D scene Box as the test case, and an Astra review of this ticket's first draft (17 findings, folded in below; its first draft reused Moves as the delegate's operations, which the review showed carry Human Message semantics a delegate doesn't have).

## Goal

Anyone writing the story changes a Box by writing a plain-text request in a passage, such as `<scene>put the lantern on the table</scene>`. That includes the story model in its reply and the writer in a guidance Message. Once the passage settles, a small libfx agent, the Box's **delegate**, turns the request into one batch of the Box's declared operations, and the Box reduces that batch into the passage's record. The story model needs no tool calls, every backend works, and the delegate can only propose operations that the Box's own reducer accepts.

The story model sees the result on its next turn, through the Box's prompt items. A query answered within the same turn is out of scope.

## Ownership

- `src/server/box` (the delegate job in the background queue, its settings, record and error writes, the shared tag parser's server use)
- `src/server/authoring/provider.ts` and the profile resolution Creator Mode does in `index.ts` (shared, not copied)
- `src/shared/contract` (descriptor `delegate`, the hook, settings, scenario scripting, the tag parser)
- `src/client` (the host lens, the failure notice, the settings editor, window refresh)
- `src/server/authoring` (`contract.md`, `run_scenario`, Install's version rules)

## Design decisions already made

### What a delegating Box declares

- `delegate: { tag, operations, summary, description, off }` in the descriptor:
  - `tag` is the element name written in prose, lowercase words joined by `-`. Install and the loader refuse a tag another loaded Box uses for a delegate or a lens; Phone's lens tag counts.
  - `operations` is a schema for **one batch**: a `Type.Array` of the Box's operation shapes, with its own `maxItems`.
  - The three strings word the Box's delegate setting, as `decision`'s do.
- The logic declares `delegate.apply({ setup, state, operations, cast }) → record`, which may be async. It is the one place operations become state, and it enforces legality itself: a throw fails the run with its message. Schema validation alone authorizes nothing.
- A delegating Box must declare `record`, `read` with its own window, and `alwaysRender`, so the instructions that teach the tag reach every prompt even before the Box has items. It must not declare `decision`. Its `advance` may return items but never a record, so the delegate is the only producer of the automatic record. Writers change the Box the same way the story model does: by writing the tag in their own Message, or through the window's own commits to Box values.

### When it runs, and on what state

- A delegate run is a job in the existing [digest queue](../../box-system/README.md#digest-queue-and-catch-up), under its landing rules and at the job's [version](../../box-system/README.md#versions). Catch-up queues tagged passages without a record, and retries failed ones.
- **Jobs of one Chat and Box run one at a time, in passage order.** A passage's run sees the state folded from the selected records **strictly before** that passage, never its own previous record or any later one. Both the agent and `delegate.apply` get that state, so a retry can't apply its request twice. Later records are never re-evaluated, as [`record` and `records`](../../box-system/README.md#record-and-records) says.
- Only passages holding the tag get a job. A passage without the tag gets no record.
- The digest queue and its routes, which today assume `digest ⇒ decision ⇒ passage timeline`, get a job kind for delegates. The places that change: `runDigest`, `digestTarget`, `prepareBoxDigests`, `digestView`, `readDigest`, the retry and catch-up handlers in `src/server/contract/box-window.ts`, the settings routes' `isDigestBox` gate, and the hook-shape checks in `registry.ts`. A delegating Box keeps its own `read` and window; it never gets the passage timeline.

### The agent

- One libfx agent per job (`createFxAgent`, Wasm, `memory()`), built from the Box's delegate setting through the same profile resolution Creator Mode uses. That resolution moves to a shared function: a missing profile, unreadable credentials and `libfxProvider`'s refusals all give a reason. "No selection" means the delegate is off. A selection that fails to resolve is broken, and the window's notice shows the reason.
- The job's abort cancels the agent's turn and its fetches, and the agent is closed in `finally`. Model requests and tool calls count against **one** 10-step cap; past it, the run fails with that reason.
- The agent's prompt holds the passage, the request text, and the passage-relative state as JSON. Past 64 KiB, the run fails with that reason rather than cutting structured state short. It has one tool, `apply(batch)`, checked against `operations`. The first valid call is the batch. A second call, or an agent that ends without calling it, fails the run. Nothing is written until the agent's turn ends successfully and `delegate.apply` returns.
- The prompt and the batch are its whole reach. It never sees `read`'s view, Box values, the Library, Characters or the database. A request injected into prose can propose only operations the reducer accepts. `contract.md` says so.

### The tag in prose

- One parser in `src/shared` finds the tag in a passage. The server's extraction and the client's lens both use it, so what runs is exactly what's lifted. Nested or unclosed tags stay raw text and run nothing. Several tags in one passage are joined, in order, into one request.
- The host gives every delegating Box a lens for its tag, sandboxed Boxes included, attached to the client definition the host builds for them. The prompt keeps the markup, so the model remembers what it asked for. `LensedProse` renders the Chat's pinned clients (`chatBoxClients`), not the catalog's.

### Versions, settings, refresh

- Once a version declares `delegate`, Install refuses a later version that drops it or changes its `tag`, as with `decision`. Dropping or renaming means making a new Box.
- The delegate setting is stored in `library_data` under `box-delegate`: connection profile and model. It's edited in Connection Settings beside the Decision Model settings, from the catalog.
- When a delegate result or failure lands, the Box's open window refreshes its read and its notice. This uses the mechanism the passage timeline uses while open, so a window doesn't wait for a Conversation revision.
- The notice at the top of the window reads "The delegate failed on Message N: <reason>", with **Retry**, which queues that passage again. Writer overrides (`set-box-record`) work as for any Box with a record.

### Scenarios

- `run_scenario` turns and swipes gain `delegated?: batch`, the batch the agent would apply for that step's prose. It's checked against the `operations` of the version running that step and reduced by its `delegate.apply`. The result is that Variant's record, so the 04b replay and Update checks see it. Scripted batches never become Human Message Moves. A step whose prose holds the tag but scripts no batch fails the scenario, saying the step needs `delegated`.

## Work

- [x] Contract: `delegate` in the descriptor (sandboxed and trusted); the tag pattern and collision check; the rules (requires `record`, `read`, `alwaysRender`; refuses `decision` and an `advance` that returns a record); `delegate.apply` in the server contract and the sandboxed adapter.
- [x] The shared tag parser, with unit tests on nested, unclosed, several-tag and escaped input.
- [x] Shared profile resolution (moved from Creator Mode), the `box-delegate` setting, its routes and its editor.
- [x] The delegate job kind: ordering per Chat and Box, passage-relative state, the agent with `apply` and the one-step-budget cap, abort and close, landing rules, catch-up and retry; the digest-only gates listed above become kind-aware.
- [x] The host lens on host-built clients, `LensedProse` on pinned clients, the window notice with Retry, and refresh on landing.
- [x] Install's version rule for `delegate` and `tag`.
- [x] `run_scenario`: `delegated` on turns and swipes; `contract.md` documents `delegate`, `operations`, `delegate.apply`, the agent's reach, the rules and `delegated`.
- [x] Tests, each failing before its code:
  - a tagged passage runs once and lands its record; an untagged one gets no job;
  - two tagged passages run in order, the second seeing the first's record; a retry of the first doesn't re-run the second or see its own previous record;
  - a batch outside `operations`, a second `apply`, no `apply`, more than 10 steps, and state over 64 KiB each fail with their reason;
  - an edit in flight drops the result;
  - a reducer that throws fails the run with its message;
  - the Box-shape rules are refused;
  - no selection runs nothing; a broken selection shows its reason;
  - a swipe's `delegated` lands on the swipe's Variant.

  The delegate's model is a localhost fake, as in the authoring tests.
- [x] e2e: a sandboxed Box with `delegate` and a window. The story model's scripted reply holds the tag; the story view shows the lifted mark; the scripted delegate calls `apply`; the open window shows the new state without a reload; the next Prompt Plan has the Box's item for it.
- [x] README: a delegate section, linked from the contract, `decision`, the digest queue and the lens sections.
- [x] Run focused tests and lint on changed files; push and let CI run the full suite and e2e. If the change passes about 30 files, split it into stacked PRs (for example: contract, parser and settings; the job; client and scenarios).

## Acceptance

- The story model or the writer changes a delegating Box only through one batch its reducer accepts, folded from the state before the passage.
- A delegate run lands at most one record per passage, under the queue's landing rules, in passage order per Chat and Box.
- A scenario of a delegating Box makes no model calls.

## Out of scope

- Tool calls in the story model's own Generation, and queries answered within one turn.
- Images of the Box in the prompt.
- A Box that both digests and delegates, and agent pooling or persistence.
