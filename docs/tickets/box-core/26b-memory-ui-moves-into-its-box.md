# Memory's UI moves into its Box

Status: TODO

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

- [ ] Add the four generic surfaces to the Box client registration and render them in the host.
- [ ] Move the Memory UI files into `src/boxes/memory/` (`client-*.tsx` layer naming) and register them on those surfaces.
- [ ] Replace the host Memories icon with Memory's `TopBarItem`, keeping message-focus opening.
- [ ] Remove the registry's Memory re-exports (`export * from "../../boxes/memory/..."`) and every `src/client` import of Memory code.
- [ ] Document the new surfaces in `docs/box-system/README.md`.
- [ ] Run `bun run check` and the full `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- `git grep -iE "memor" -- src/client` finds no Memory UI, contract or helper code. Generic code that merely mentions Memory in a comment is allowed.
- The only `src/client` file importing from `src/boxes/` is `src/client/box-windows/registry.tsx`, and only Box client modules and descriptors, no `export *` re-exports.
- A Box gets an inspector, a settings section, a participant section or a trace view by declaring it in its client registration, with no host edit.
