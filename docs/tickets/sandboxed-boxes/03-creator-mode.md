# Creator Mode

Status: TODO

Blocked By: 02b, 02c

Source: `docs/research/deepseek-harness-creator-mode.md`, `docs/research/sandboxed-box-spike.md` (libfx), `docs/research/sandbox-box-landmark-fit.md`, and the implementation notes of tickets 01–02c.

## Goal

A writer chooses **Create a Box** in the Box manager, picks a coding model, and describes a mechanic. An embedded `libfx` agent writes a sandboxed Box's files and checks them with `run_scenario`, and the panel shows the scenario results: diagnostics, folded state and prompt items. **Install** makes the Box available app-wide under a new id, without a restart. It is then added to a Chat and its UI is used the ordinary way.

This is the first slice. Revising an installed Box, a live preview of an uninstalled candidate's UI, and authoring sessions that survive a restart are in ticket 03b.

## Ownership

- `src/server/authoring` (agent, host tools, candidate folders, the agent-facing contract)
- `src/server/box` (an extracted candidate check shared with the loader, and adding one Box to the running registry)
- `src/client/box-windows` (authoring panel, Install, refreshing the Box definitions)
- The e2e `llm` fixture (an authoring Chat Completions route)

## Design decisions already made

- **The agent.** `libfx` 0.0.16, pinned, with one backend chosen explicitly (the spike ran both on this host; that is not a portability claim). It has no built-in tools: it can only use the host tools below. Only the code it writes is untrusted, and that runs only in the sandboxed runtime.
- **The tool arguments are untrusted too.** They come from a model reading the writer's prose. So:
  - Candidates live in a host-created folder outside the plugin folder: `data/authoring/<session>/<candidate>/`. The host owns that path and the candidate's id. No tool takes a path.
  - The write tools set content only, for fixed files (`descriptor.json`, `logic.js`, `ui.js`, `ui.css`). Each has a byte cap checked before writing, and writes go through `replaceFile`. Dependency files, the lock and bundles are only written by the host's build.
  - Scenarios and Install load the candidate exactly as the loader loads a plugin: `sandboxedFolder` walk and snapshot, then descriptor validation, then `sandboxedSources` (confined build), then the checked hooks. That chain is extracted into one function the registry and the authoring tools both call, so the authoring path cannot skip a step or approve output the loader would refuse. An incomplete candidate never goes through plugin discovery.
  - While a scenario or Install runs, the candidate's files are locked against writes, so Install publishes exactly the bytes it checked.
- **`run_scenario` contract.** It takes:
  - `setup` (when the Box has one), a `cast` of names, a `seed`
  - a list of turns, each with `moves`, an optional `prose` passage and scripted `decisions`
  - `swipes` as an index into earlier turns

  A Swipe keeps that turn's seed and Moves and selects its records without recalculating later ones, as a real Swipe does.

  It runs on one adapter per scenario, disposed afterwards. `fold`, `advance`, `dependencies` and `digest` run as in production, with scripted `decide` answers. `read` runs against **scripted snapshot answers**, never the database: the guest read invocation is separated from the production `boxSnapshot` provider, so a scenario supplies its own answers.

  It returns prompt items, folded state, records and their total bytes, `read` output (for Boxes with a window) or `status` (digest Boxes), and every diagnostic the loader would raise. `host.render` is browser work, so it isn't part of a scenario.
- **Install** adds one new sandboxed Box. It refuses an id any folder already uses. It:
  - copies the complete checked artifact (descriptor, sources, `ui.css`, `deps/`, `deps.lock.json`, bundles) to `data/boxes/<id>/` (`/app/data/boxes/<id>/` in Docker), through a temp folder renamed into place
  - adds it to the server registry **without reloading or disposing existing Boxes' runtimes** (today `loadBoxes` reloads everything)
  - tells the client to refresh its Box definitions so the Box manager lists it

  Install is distinct from **Add to this Chat**, which stays the existing per-Chat action. Sandboxed Boxes have no custom server routes, so no route hot-reload is needed.
- **The coding model.** It's a host picker over the writer's connection profiles, independent of the prose model. The first supported shape is OpenAI-compatible Chat Completions. Map the profile explicitly to libfx's `provider: { name, baseUrl, models }` and `credentials`:
  - Base URL versus an exact request URL (`src/shared/connection-url.ts`)
  - API key and custom headers
  - context and output limits

  A profile setting that can't be mapped is refused with a visible reason. Verify the mapping against a localhost fake before building the panel.
- **The session** is in memory: one conversation per open panel, with cancel, and follow-up prompts after a turn ends. There's no `ask_writer` tool (the agent asks in its reply), no mid-turn steer, and no sessions table. Closing the panel or restarting the server ends the session. Its candidate folder is removed when the panel closes, and any left over are swept at startup.
- **Install is a writer action, never an agent tool.** Authoring messages and logs never become story Messages or Memories.

## Work

- [ ] Extract the candidate check (walk, descriptor, sources, checked hooks) from the registry into one shared function, and separate the guest `read` invocation from the production snapshot provider.
- [ ] Candidate folders under `data/authoring/`, with the content-only write tools, byte caps and the write lock during checks.
- [ ] `read_contract`: the agent-facing sandboxed Box contract in `src/server/authoring/`, since Docker copies `src/server` but not `docs/`. It includes the guest UI API, the canvas bridge, dependencies and their limits, and the rule that records hold snapshots or deltas, never logs that copy earlier records. Add the sandboxed Race and Mood sources as examples.
- [ ] `run_scenario` with the contract above.
- [ ] The agent: `createFxAgent` with these tools, the profile mapping, events streamed to the client, and cancel.
- [ ] Install, adding one Box to the running registry and refreshing the client's Box definitions.
- [ ] The panel: **Create a Box** in `BoxManager`, the coding-model picker, the agent chat, scenario results (diagnostics, folded state, prompt items), and **Install**.
- [ ] The e2e fixture: a localhost Chat Completions route for libfx, backed by the fixture's scripting and logging. It supports tool-call deltas, `finish_reason: "tool_calls"` and tool-result messages, fails unscripted authoring requests, and stays separate from story requests.
- [ ] e2e: the fixture scripts the agent's tool calls to write an inventory Box, `run_scenario` returns the expected prompt items, Install makes it available without a restart, and adding it to a Chat and staging a Move produces the expected Prompt Plan. No esm.sh and no external network.
- [ ] Contract tests:
  - a tool argument naming a path or an oversized body is refused
  - Install refuses an existing id
  - Install leaves the other Boxes' runtimes untouched
  - a candidate the loader would refuse fails `run_scenario` with the loader's diagnostic
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- A Box built and installed through the panel behaves the same as one copied in by hand.
- The agent cannot read or write anything except its candidate's fixed files through its tools.

## Open risks

- [Ticket 00 measured](../../research/sandboxed-box-spike.md) libfx 0.0.16 native and WASM agent loops under Bun 1.4.4 on Linux x86_64, without flags. Other platforms are unmeasured. `libfx` is experimental.
- Generated Boxes can use `decide` inside `digest`. `complete` and `embed` arrive with the Memory capability work in #69.
