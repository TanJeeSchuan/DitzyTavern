# Creator Mode

Status: TODO

Blocked By: 02b

Source: `docs/research/deepseek-harness-creator-mode.md`, `docs/research/sandbox-box-landmark-fit.md`, ticket 00 findings.

## Goal

A writer chooses **Create a Box** in the Box manager, describes a mechanic, and an embedded `libfx` agent writes a sandboxed Box, checks it with `run_scenario`, and shows a live preview. The writer installs it with a button, without a restart, and revises it in the same authoring session.

## Ownership

- `src/server/authoring` (agent, host tools, sessions)
- An authoring sessions table (checkpoint blob)
- `src/client/box-windows` (authoring panel, preview, Install)
- Runtime activation in `src/server/box` registry and the client Box list

## Design decisions already made

- `libfx` has no built-in tools. The agent can only use the tools below, so it needs no sandbox of its own. Only the code it writes is untrusted, and that only runs in the sandboxed Box runtime.
- The coding model is its own setting, chosen in a host picker from the writer's connection profiles; it must support tool calls. It is independent of the prose model.
- Install is a writer action, never an agent tool.
- Authoring messages and logs never become story Messages or Memories.

## Work

- [ ] Host tools: `read_contract` (the agent-facing sandboxed Box contract, kept in `src/server/authoring/` because the Docker image copies `src/server` but not `docs/`, plus the sandboxed Race and Mood in `src/boxes` as examples), `write_descriptor`, `write_logic`, `write_ui` (save the candidate), `run_scenario({ moves, swipes, prose?, decisions? })` (run the candidate's hooks in QuickJS against a scripted history and return folded state, prompt items and `read` output; `decisions` scripts the answers `decide` returns during digests, so a scenario costs no model calls and gives the same result every time), `ask_writer`. The contract tells the agent that records hold snapshots or deltas, never logs that copy earlier records. `run_scenario` also reports total record bytes after a long scripted history, so the agent sees growth before the writer does.
- [ ] Agent: `createFxAgent` with those tools, the authoring instructions, `provider`/`credentials` from the chosen profile, and events streamed to the client. Support cancel and steer.
- [ ] Sessions: store the libfx checkpoint per authoring session; sessions whose checkpoint no longer loads after a libfx upgrade are discarded.
- [ ] Panel: **Create a Box** in `BoxManager`, a chat view of the agent, the candidate's live frame and prompt items, and **Install**.
- [ ] Runtime activation: Install validates the candidate as the loader does, writes only its `descriptor.json`, `logic.js` and `ui.html` to `data/boxes/<id>/` (`/app/data/boxes/<id>/` on the Docker volume), and registers it without a restart through ticket 01's client registration path. Creating needs an id no folder uses yet. Revising targets the id this authoring session installed. Activating a revision is refused while that Box has a Generation preparing or active, or a digest running, as a Fork is refused during an Active Generation (ADR-0052); the panel says why and the writer retries. Capture can't cancel one Box's work, so this never tries to. The Box's version is part of its preview fingerprint, so a saved preview made with the old version is stale. Old and new versions never run side by side. A failed candidate leaves the installed version untouched, and stored-value schema changes are reported before activation.
- [ ] e2e: the `llm` fixture scripts the agent's tool calls to write an inventory Box; `run_scenario` returns the expected prompt items; Install makes it available without restart; a Move in a Chat produces the expected Prompt Plan.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- A Box built and installed through the panel behaves the same as one installed by hand.
- The agent cannot read or write anything except through its tools.

## Open risks

- Whether `libfx` loads natively under Bun or needs the WASM backend (ticket 00).
- `libfx` is experimental; pin the version.
- The e2e fake provider must answer tool-call requests in the shape `libfx` sends.
- Generated Boxes can use `decide` inside `digest` (ticket 02b). `complete` and `embed` arrive with the Memory capability work in #69.
