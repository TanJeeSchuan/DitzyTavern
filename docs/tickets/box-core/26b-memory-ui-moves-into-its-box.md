# Memory's UI moves into its Box

Status: DONE

Blocked By: 26-boxes-are-discovered-from-folders

Source: GitHub #72 and #77. Ticket 27 requires that `src/client` import nothing from `src/boxes/`, and plugins may contribute every surface a built-in uses. The in-tree Memory UI (about 1,500 lines) still reaches Memory through `src/client/box-windows/registry.tsx`, which re-exports Memory's `contract`, `shared` and `client` modules. This ticket moves that UI into the Memory Box, onto generic client surfaces, so ticket 27 can load every Box UI as a module.

## Goal

Memory's UI lives in `src/boxes/memory/` and plugs into generic surfaces that any Box can use. The host client names no Box. The registry's Memory re-exports are gone. Memory works exactly as before.

## Decisions

- **This is a move, not the redesign in GitHub #24.** Behavior, copy and layout stay the same.
- Each surface the Memory UI uses becomes a generic, optional entry in a Box's client registration (`src/client/box-windows/registry.tsx`), next to `Panel`, `DockTab` and `TopBarItem`:
  - **Details inspector:** the Memories panel (`MemoriesPanel.tsx`, `MemorySource.tsx`, `MemoryCoverage.tsx`, the allowance, note, identity and label-merge dialogs). This includes the ways to open it today: the top bar icon and the message "Memories" action, both with message focus.
  - **Settings section with a nav rail item:** `MemorySettingsEditor.tsx` and its `NavigationRail` / `PrimaryPanelView` wiring.
  - **Participant-editor section:** `characters/ParticipantMemory.tsx`.
  - **Generation trace view:** Memory's part of `GenerationDetailsPanel.tsx`. It renders the Box's trace from `box_traces_json` (ticket 23).
- The host renders each surface for every registered Box that declares it. A surface tied to a Chat shows only for Boxes enabled in that Chat. Settings and participant sections show for every loaded Box.
- **The Memories top bar icon becomes Memory's `TopBarItem`** (ticket 24), opening the Memories inspector. Remove the host-owned icon from `StoryHeader.tsx`. This completes GitHub #77.
- **SDK exports:** `src/box-sdk/client.ts` exports what these UIs need from the host (components, hooks, `boxApi`), named for what they do, not for Memory. Nothing host-internal leaves through it.
- **Tests:** client tests for Memory logic (`memories-view.test.ts`) move with their code. Memory e2e specs (`e2e/memory.spec.ts`, `box-lifecycle.spec.ts`, `story-jump.spec.ts`) pass unchanged, apart from locators that change because the icon moved. Add no UI tests (AGENTS.md).
- The registry still imports Box client modules statically. Ticket 27 replaces that with module loading.

## Work

- [x] Add the four generic surfaces to the Box client registration and render them in the host.
- [x] Move the Memory UI files into `src/boxes/memory/` (`client-*.tsx` layer naming) and register them on those surfaces.
- [x] Replace the host Memories icon with Memory's `TopBarItem`, keeping message-focus opening.
- [x] Remove the registry's Memory re-exports (`export * from "../../boxes/memory/..."`) and every `src/client` import of Memory code.
- [x] Document the new surfaces in `docs/box-system/README.md`.
- [x] Run `bun run check` and the full `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- `git grep -iE "memor" -- src/client` finds no Memory UI, contract or helper code. Generic code that merely mentions Memory in a comment is allowed.
- The only `src/client` file importing from `src/boxes/` is `src/client/box-windows/registry.tsx`, and only Box client modules and descriptors, no `export *` re-exports.
- A Box gets an inspector, a settings section, a participant section or a trace view by declaring it in its client registration, with no host edit.

## Implementation and verification

- Memory owns its inspector, settings, participant section, trace view, helpers, tests and stylesheet. The host registers optional `Inspector`, `Settings`, `ParticipantSection` and `TraceView` surfaces in `boxClients`, alongside its window, primary panel and top bar item.
- Inspector openers preserve message focus and the narrow Chat title menu. Chat surfaces hide while their Box is disabled; settings and participant sections remain available for loaded Boxes. Connection helper copy now describes Box tasks without naming Memory.
- The registry no longer re-exports Memory modules or imports other Boxes' shared helpers. Phone and Thoughts create their lenses through `createBoxLens` in their client modules.
- After the final code change, ran `bun run check` and then the full `bun run test:e2e`, sequentially under `/tmp/ditzy-heavy.lock`: 133 lint-rule tests, 1,492 unit tests across 172 files, 3 harness tests, and 76 e2e tests passed. Lint, contract ownership and both typechecks passed; lint still reports warnings.
- Earlier focused runs passed all 8 moved Memory view tests, 2 inspector-focus reducer tests, 3 Memory e2e flows, 3 new Box inspector e2e flows and 7 lifecycle e2e flows. The lifecycle reply locator now uses an exact match because `One.` also matched `Check the phone.`.
- No component or snapshot tests added. No code review run. Nothing left open in this ticket; runtime client-module loading remains ticket 27.
