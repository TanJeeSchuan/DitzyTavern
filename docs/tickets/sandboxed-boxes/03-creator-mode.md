# Creator Mode

Status: DONE

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
  - Scenarios and Install load the candidate exactly as [the loader loads a sandboxed Box](../../box-system/host.md#loading), through one function the registry and the authoring tools both call, so the authoring path cannot skip a step or approve output the loader would refuse. An incomplete candidate never goes through plugin discovery.
  - While a scenario or Install runs, the candidate's files are locked against writes, so Install publishes exactly the bytes it checked.
- **`run_scenario` contract.** It takes:
  - `setup` (when the Box has one), a `cast` of names, a `seed`
  - a list of turns, each with `moves`, an optional `prose` passage and scripted `decisions`
  - `swipes` as an index into earlier turns

  A Swipe selects records as [`record` and `records`](../../box-system/authoring.md#record-and-records) describe for a real one, keeping that turn's seed and Moves.

  It runs on one adapter per scenario, disposed afterwards. `fold`, `advance`, `dependencies` and `digest` run as in production, with scripted `decide` answers. `read` runs against **scripted snapshot answers**, never the database: the guest read invocation is separated from the production `boxSnapshot` provider, so a scenario supplies its own answers.

  It returns prompt items, folded state, records and their total bytes, `read` output (for Boxes with a window) or `status` (digest Boxes), and every diagnostic the loader would raise. `host.render` is browser work, so it isn't part of a scenario.
- **Install** adds one new sandboxed Box. It refuses an id any folder already uses. [Ticket 04](04-box-versions.md) replaced this with "create a version, then move `latest`": versions now run side by side, each Chat on the one it pins. It:
  - copies the complete checked artifact (descriptor, sources, `ui.css`, `deps/`, `deps.lock.json`, bundles) to `data/boxes/<id>/` (`/app/data/boxes/<id>/` in Docker), through a temp folder renamed into place
  - adds it to the server registry **without reloading or disposing existing Boxes' runtimes** (today `loadBoxes` reloads everything)
  - tells the client to refresh its Box definitions so the Box manager lists it

  Install is distinct from **Add to this Chat**, which stays the existing per-Chat action. Sandboxed Boxes have no custom server routes, so no route hot-reload is needed.
- **The coding model.** It's a host picker over the writer's connection profiles, independent of the prose model. The first supported shape is OpenAI-compatible Chat Completions. Map the profile explicitly to libfx's `provider: { name, baseUrl, models }` and `credentials`:
  - Base URL versus an exact request URL (`src/shared/connection-url.ts`)
  - API key and custom headers

  A profile setting that can't be mapped is refused with a visible reason. Verify the mapping against a localhost fake before building the panel.
- **The session** is in memory: one conversation per open panel, with cancel, and follow-up prompts after a turn ends. There's no `ask_writer` tool (the agent asks in its reply), no mid-turn steer, and no sessions table. Closing the panel or restarting the server ends the session. Its candidate folder is removed when the panel closes, and any left over are swept at startup.
- **Install is a writer action, never an agent tool.** Authoring messages and logs never become story Messages or Memories.

## Work

- [x] Extract the candidate check (walk, descriptor, sources, checked hooks) from the registry into one shared function, and separate the guest `read` invocation from the production snapshot provider.
- [x] Candidate folders under `data/authoring/`, with the content-only write tools, byte caps and the write lock during checks.
- [x] `read_contract`: the agent-facing sandboxed Box contract in `src/server/authoring/`, since Docker copies `src/server` but not `docs/`. It includes the guest UI API, the canvas bridge, dependencies and their limits, and the rule that records hold snapshots or deltas, never logs that copy earlier records. Add the sandboxed Race and Mood sources as examples.
- [x] `run_scenario` with the contract above.
- [x] The agent: `createFxAgent` with these tools, the profile mapping, events streamed to the client, and cancel.
- [x] Install, adding one Box to the running registry and refreshing the client's Box definitions.
- [x] The panel: **Create a Box** in `BoxManager`, the coding-model picker, the agent chat, scenario results (diagnostics, folded state, prompt items), and **Install**.
- [x] The e2e fixture: a localhost Chat Completions route for libfx, backed by the fixture's scripting and logging. It supports tool-call deltas, `finish_reason: "tool_calls"` and tool-result messages, fails unscripted authoring requests, and stays separate from story requests.
- [x] e2e: the fixture scripts the agent's tool calls to write an inventory Box, `run_scenario` returns the expected prompt items, Install makes it available without a restart, and adding it to a Chat and staging a Move produces the expected Prompt Plan. No esm.sh and no external network.
- [x] Contract tests:
  - a tool argument naming a path or an oversized body is refused
  - Install refuses an existing id
  - Install leaves the other Boxes' runtimes untouched
  - a candidate the loader would refuse fails `run_scenario` with the loader's diagnostic
- [x] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [x] Set this ticket to DONE and commit.

## Acceptance

- A Box built and installed through the panel behaves the same as one copied in by hand.
- The agent cannot read or write anything except its candidate's fixed files through its tools.

## Open risks

- [Ticket 00 measured](../../research/sandboxed-box-spike.md) libfx 0.0.16 native and WASM agent loops under Bun 1.4.4 on Linux x86_64, without flags. Other platforms are unmeasured. `libfx` is experimental.
- Generated Boxes can use `decide` inside `digest`. `complete` and `embed` arrive with the Memory capability work in #69.

## Implementation notes

- **Files.** `src/server/authoring/`: `candidate.ts` (folders, capped content-only writes, the hold), `tools.ts`, `scenario.ts`, `install.ts`, `provider.ts` (profile to libfx), `contract.md` (`read_contract`), `index.ts` (sessions and routes). `checkSandboxedFolder` and `addBox` are in `src/server/box/registry.ts`; `sandboxedBox` now returns `guestRead(input, snapshot)` beside the production `read`. The panel is `src/client/box-windows/CreateBox.tsx`, opened from the Box manager. Wire schemas are in `src/shared/contract/authoring.ts`.
- **The id.** The candidate's folder is named `authored-<8 hex>`, and `write_descriptor` writes the agent's object with that `id`, so the loader's folder-name check passes and the agent never names an id. Install publishes under it.
- **The hold.** Writes and checks go through one queue per candidate, so a write during a scenario or Install waits for it to end rather than failing. Each tool is `writes: true`, so libfx runs one call at a time.
- **Install** (until ticket 04) copied the candidate's walked snapshot into `<plugins>/../.box-install-<uuid>/<id>/`, ran `checkSandboxedFolder` there (which writes any `deps/`, lock and bundles beside it), and renamed that folder into the plugin folder. What is registered is the runtime that check built, so nothing is checked twice. The client re-reads the Chats before `loadBoxClients`, so no Box manager row renders before its Chat knows the Box.
- **Scenario.** One turn is a Human Message (its Moves rendered) and the passage answering it. Each turn's seed is `boxSeed("<seed>:<index>", id)`. `dependencies` and the digest get an in-memory SQLite handle nobody reads, rather than a cast. Scripted answers go through `checkedDecisionAnswers`, extracted from `requestDecisions`, so they're checked as a provider's are.
- **Mapping, verified against a localhost fake** (`provider.test.ts`, real libfx): libfx sends `{baseUrl}/chat/completions`, with no `max_tokens`: the session declares no limits (2026-11-04, after an 8,192-token default cut the agent off mid-reasoning), so the provider's own default applies. Its `fetch` option carries the app's `authenticatedHeaders` (custom headers, a custom `Authorization` wins) and the profile's inactivity timeout. It refuses non-Chat-Completions profiles, a URL that doesn't end in `/chat/completions` or carries a query, HTTP to a host other than localhost (libfx's own rule), `max_completion_tokens`/`omit`, an unreadable key, and an output limit not below the context window.
- **Backend.** Wasm, explicitly: it runs anywhere Bun does, while the native addon ships for four platforms.

### Fix round 1 (Astra review of b4986866...7507d19)

- **Budget.** Each writer message buys `PER_MESSAGE`: 40 model requests and 40 tool calls. Requests are counted in the provider `fetch`, before each leaves, so a model looping on a tool it does not have, which never reaches a tool, is held too (the review's probe made 49 such requests before). The next past either cancels the turn, which ends with `stopReason: "budget"` and a reason the panel shows. `session.test.ts` drives the real routes and libfx against fakes looping on a real tool, on an unknown tool, and asking for 45 calls in one response.
- **Install publishes in one step.** It claims the target with an exclusive `mkdir`, then renames the whole checked folder over that empty claim, so the target is never seen half filled; a failed rename removes the claim only while it is empty.
- **After Install the client adds every Box it has not loaded**, so a Box another writer installed meanwhile appears too; loaded definitions stay as they are.
- **Cancellation is checked right before every package, lock and bundle write**, so a cancel that lands after a download writes nothing.
- **Install publishes without replacing.** The existence check before validation stays. Publishing then creates the target folder with a plain `mkdir`, which fails on `EEXIST`, and moves the checked files into it. A folder that appeared during validation refuses the Install and is left alone (tested by creating it from inside the check).
- **Descriptor cap.** `descriptor.json` is written compactly with the id, and the cap is checked on the agent's text and again on the exact text written.
- **Cancel.** libfx's `signal` reaches every tool. A write or scenario still waiting in the candidate's queue is dropped once it aborts. A running scenario stops between turns and reports "The scenario was cancelled.". Dependency fetches abort with it: `checkSandboxedFolder`, `sandboxedSources` and `pinnedPackages` now take a signal. `remove` waits behind the candidate's in-flight work.
- **Digest history.** A scenario's digest now reads raw prose, as `digest.ts` does: the human Message's content is its prose (empty in a scenario), never its rendered Moves. A turn whose passage is blank isn't digested. The rendered Moves stay in the report.
- **Client refresh.** After Install the client registers only the new Box (`addBoxClient`). Every other definition keeps its identity, so open frames and Workers survive; the e2e keeps a Race window open across Install and the next Generation.
- **Panel lifecycle.** Closing the panel unmounts it, which deletes its session. A Start answered after the panel closed deletes the session it started. The e2e checks that the authoring folder is empty after close. The Start race itself has no test, since Start answers without a network call.
- **e2e.** The scripted agent no longer writes `ui.css`, so the spec covers #202's empty-stylesheet path.

### Soft step cap (follow-up)

- **Steps per message** is a per-session setting: `40` (the default), `100` or no limit (`null`). It is sent when the session starts and changed between turns with `PUT /api/authoring/sessions/:session/steps`. It isn't stored anywhere but the in-memory session. Model requests and tool calls each count against it separately.
- **A pause, not a cancel.** The next request (in the provider `fetch` wrapper) or tool call (in `spend`) past the limit awaits the message's pause, and the stream sends `{ type: "paused", steps }`. `POST …/continue` raises this message's limit by `CONTINUE_STEPS` (20, in the shared contract so the panel's label matches), and whatever waited goes on mid-turn. `POST …/cancel` on a paused message ends it with `stopReason: "budget"` and `budgetSpent(steps)`; on a running message it cancels as before. A waiter also gives up when its libfx signal aborts, and closing the session rejects the pause, so a paused turn never hangs. With no limit nothing pauses.
- **Tests.** `session.test.ts` drives the real routes and libfx against looping fakes:
  - a pause at the limit with nothing more reaching the fake (a real tool and an unknown one);
  - Continue lets exactly 20 more through, then Stop ends the turn with `budget`;
  - closing a paused session cancels its turn;
  - no limit runs to the fake's own stop at 60;
  - 45 parallel calls pause at 40.

  A `settle` helper reads events that arrive just after `paused`: libfx delivers the last `tool_end` after the next request's pause is already streamed.

### Activity window (follow-up)

- **Stream.** `tool` events now carry the call's input as JSON text, and `tool-end` its result, each cut at `SHOWN_BYTES` (64 KiB) on a UTF-8 boundary and marked `truncated`. libfx's own `inputPreview` stays marked even when it is short (`activity.ts`, `activity.test.ts`). `reasoning_delta` streams as `reasoning`.
- **Panel.** The conversation keeps the left column: writer and agent text and errors. On the right:
  - **Activity** lists each step as a native `<details>`: the tool name, a short summary (the file and its size, the scenario's turns, the contract or example), and running/ok/failed. Opened, it shows the input as written and the result. Reasoning shows as a dashed, dimmed entry. A step's body is built only when it is opened.
  - **Files** lists the candidate's fixed files from `GET …/files`, which reads `descriptor.json`, `logic.js`, `ui.js` and `ui.css` when present. The panel refreshes it after each successful write and when the turn ends.
- **Code.** A read-only CodeMirror view (`EditorState.readOnly`, `EditorView.editable.of(false)`) highlights JavaScript and JSON with `classHighlighter`, whose `tok-*` classes take theme colours. `ui.css` shows as plain text. Pinned exactly: `@codemirror/lang-javascript` 6.2.5 and `@codemirror/lang-json` 6.0.2, plus `@codemirror/language` 6.12.4 and `@lezer/highlight` 1.2.5, which highlighting imports directly, at the versions already in the lockfile. The panel is lazy-loaded from the Box manager, so none of this joins the main bundle.
- **Scenario setup.** A scenario now falls back to `setup.initial` only when `setup` is absent, so an explicit `null` reaches the Box or is refused by its schema (tested both ways).

### Fix round 1 for the step cap and Activity (Astra review of 7c27f4d..f25232d)

- **Continue and Stop** keep the pause on screen until the server takes the answer; one that fails shows why and leaves both controls.
- **Steps** change only between turns: `PUT …/steps` answers 409 while a turn runs or is paused (`session.test.ts`).
- **Reasoning** is held to `SHOWN_BYTES` per entry, as the panel's entries run between tool calls (`reasoningEntry` in `activity.ts`). The delta that reaches the cap is cut and marked `truncated`, nothing more is sent until the next tool call, and the panel shows the entry as cut short (`activity.test.ts`).
- **A lazy-load failure** of the panel shows "Create a Box did not load: … Reload the page to try again." with Dismiss, in place of the panel.
- **Files** shows only the latest read: each read takes a sequence number, and an earlier answer arriving last is dropped.
