# External agent round trip

Status: Done

Blocked By: 04b (Cross-version checks), and `box:scenario` (PR #206)

Source: the Creator Mode scope discussion of 2026-11-06.

## Goal

A writer can hand a Creator Mode session to a coding agent outside the app, such as Claude Code or Codex, and take its work back into Creator Mode to install. The outside agent works on files and checks them with `box:scenario`; the app stays the only place that installs.

## Design decisions already made

- **`bun run box:export <session id> <dir>`** (`scripts/box-export.ts`) writes into `<dir>`, refused when it exists and isn't empty: the session's candidate files as a folder named for its Box id, `scenarios/<n>.json` with every `scenario-input` from the session's log in order (identical inputs once), and `AGENTS.md`, which holds `contract.md` followed by a short section on how to check (`bun run box:scenario <box folder> scenarios/*.json`) and submit (`bun run box:submit <box folder> [--box <id>] scenarios/*.json`). It reads `data/authoring/<session>/` under the app's data folder, the server's default (`cwd/data`), plus whether the Box has an installed `latest`, so a session submitted with `--box` exports with `--box` again; it refuses a session id that isn't a UUID and a `<dir>` inside the data folder, links followed, so it never writes into a session or a Box. Its commands quote the paths.
- **`bun run box:submit <box folder> [--box <id>] <scenario.json>...`** (`scripts/box-submit.ts`) creates a **new** saved session in `data/authoring/<new uuid>/` and never writes into an existing one: a running server may hold that session open, and the candidate's write queue lives only in its memory. The folder is read with `sandboxedFolder`, which refuses links, and copied into the new candidate. The candidate id is `--box <id>` when given, which must name a versioned plugin already installed (`latest` names a folder in `data/boxes/<id>/versions/`; `versions/` alone isn't enough, since a scenario run creates it), so Install makes a new version of it with 04b's checks against `latest`; otherwise a fresh `authored-xxxxxxxx`. `descriptor.json` takes the candidate id (`withId`). Each scenario runs through `run_scenario`'s own path, recording the cached check for its version hash, so the server's Install gate passes. The log gets a `prompt` line first, `Submitted from <folder>.`, then per scenario its `scenario-input` line and the `tool`, `tool-end` and `scenario` events as the panel's stream sends them, so opening the session shows each run in the Scenario panel and Install's replay finds them. `meta.json` has no coding model yet, so `profileId` and `model` are optional in `authoringMeta`, and the panel asks for a model when it opens a saved session without one; the `open` route already takes the model the writer chooses. Exit codes follow `box:scenario`: 0 when every scenario passed (it prints the new session id and "Open it in Create a Box to install."), 1 when one failed (the session is still written, so the writer can open it and ask the agent), 2 on bad arguments. It never installs.
- **`/export`** in the Create a Box panel is a Console command that prints the exact `bun run box:export <session id> <dir>` line to run, since the browser can't write to the agent's disk.
- **Out of scope**: an MCP server, installing from a CLI, writing into an existing session, any network upload route.

## Work

- [x] `scripts/box-export.ts` and `box:export` in `package.json`.
- [x] `scripts/box-submit.ts` and `box:submit` in `package.json`.
- [x] `profileId` and `model` optional in `authoringMeta`; the panel asks for a model when a saved session has none.
- [x] `/export` in the panel's commands.
- [x] README Creator Mode section: the round trip (export, check, submit, open, Install).
- [x] Tests: export writes the candidate folder, deduplicated scenarios and `AGENTS.md`, and refuses a non-UUID session and a non-empty folder; submit writes a new session that `list` shows and Install accepts, exits 1 with the session written when a scenario fails, and exits 2 without writing a session for a folder holding a link and for a `--box` that isn't an installed versioned Box.
- [x] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.

## Acceptance

- A session exported, changed by an outside agent, checked with `box:scenario` and submitted opens in Create a Box with its runs in the Scenario panel and installs, as a new Box or, with `--box`, as a new version of an installed one.
- Neither script writes into an existing session or outside `data/authoring/` and the Box's checks folder, and neither installs.
