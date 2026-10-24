# Memory's UI moves into its Box

Status: DONE

Blocked By: 26-boxes-are-discovered-from-folders

Source: GitHub #72 and #77. Ticket 27 requires that `src/client` import nothing from `src/boxes/`, and plugins may contribute every surface a built-in uses. The in-tree Memory UI (about 1,500 lines) still reaches Memory through `src/client/box-windows/registry.tsx`, which re-exports Memory's `contract`, `shared` and `client` modules. This ticket moves that UI into the Memory Box, onto generic client surfaces, so ticket 27 can load every Box UI as a module.

## Goal

Memory's UI lives in `src/boxes/memory/` and plugs into generic surfaces that any Box can use. The host client names no Box. The registry's Memory re-exports are gone. Memory works exactly as before.

## Decisions

- **This is a move, not the redesign in GitHub #24.** Behavior, copy and layout stay the same.
- Each surface the Memory UI uses becomes a generic, optional entry in a Box's client registration (`src/client/box-windows/registry.tsx`), next to `PrimaryPanel`, `Window` (with `Panel` and `DockTab`) and `TopBarItem`:
  - **Details inspector:** the Memories panel (`MemoriesPanel.tsx`, `MemorySource.tsx`, `MemoryCoverage.tsx`, the allowance, note, identity and label-merge dialogs). This includes the ways to open it today: the top bar icon and the message "Memories" action, both with message focus.
  - **Settings section with a nav rail item:** `MemorySettingsEditor.tsx` and its `NavigationRail` / `PrimaryPanelView` wiring.
  - **Participant-editor section:** `characters/ParticipantMemory.tsx`.
  - **Generation trace view:** Memory's part of `GenerationDetailsPanel.tsx`. It renders the Box's trace from `box_traces_json` (ticket 23).
- The host renders each surface for every registered Box that declares it. Inspectors and their top bar and title-menu openers show whenever the Box is not absent in the Chat, preserving access to saved data while disabled. Message actions remain enabled-only because they start digests. Captured Generation traces render regardless of current enablement. Settings and participant sections show for every loaded Box.
- **Every registered `Inspector` gets a host top bar icon and title-menu opener**, including Memories, without a `TopBarItem`. `TopBarItem` remains a separate window-opening surface (ticket 24). The host owns the inspector frame and labels it with `Inspector.label`; the Box supplies its content and header. This completes GitHub #77.
- **SDK exports:** `src/box-sdk/client.ts` exports what these UIs need from the host (components, hooks, `boxApi`), named for what they do, not for Memory. Nothing host-internal leaves through it.
- **Tests:** client tests for Memory logic (`memories-view.test.ts`) move with their code. Memory e2e specs (`e2e/memory.spec.ts`, `box-lifecycle.spec.ts`, `story-jump.spec.ts`) preserve existing flows. Inspector regressions cover disabled access on desktop and mobile, retained saved claims, trace visibility after disabling, and closure on removal/reinsertion. Add no UI tests (AGENTS.md).
- The registry still imports Box client modules statically. Ticket 27 replaces that with module loading.

## Work

- [x] Add the four generic surfaces to the Box client registration and render them in the host.
- [x] Move the Memory UI files into `src/boxes/memory/` (`client-*.tsx` layer naming) and register them on those surfaces.
- [x] Replace the Memory-specific host icon with generic inspector openers, keeping message-focus opening.
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
- Inspector openers preserve message focus and the narrow Chat title menu. Inspectors stay available while their Box is disabled and close when it becomes absent; message actions remain enabled-only. Captured traces remain visible regardless of enablement. Settings and participant sections remain available for loaded Boxes. Connection helper copy now describes Box tasks without naming Memory.
- The registry no longer re-exports Memory modules or imports other Boxes' shared helpers. Phone and Thoughts create their lenses through `createBoxLens` in their client modules.
- For the original implementation, after its final code change, ran `bun run check` and then the full `bun run test:e2e`, sequentially under `/tmp/ditzy-heavy.lock`: 133 lint-rule tests, 1,492 unit tests across 172 files, 3 harness tests, and 76 e2e tests passed. Lint, contract ownership and both typechecks passed; lint still reports warnings.
- Earlier focused runs passed all 8 moved Memory view tests, 2 inspector-focus reducer tests, 3 Memory e2e flows, 3 new Box inspector e2e flows and 7 lifecycle e2e flows. The lifecycle reply locator now uses an exact match because `One.` also matched `Check the phone.`.
- No component or snapshot tests added. No code review run. Runtime client-module loading remains ticket 27.

## Review follow-up

- [x] Restore trace visibility independent of current Box enablement and remove the threaded conversation prop.
- [x] Keep disabled inspectors reachable, restore Memory's off callout, and clear inspector selection on removal.
- [x] Use generic host inspector openers and frames; keep `TopBarItem` for windows.
- [x] Inline judgment formatting, declare digest-window icons once, rename the client registration to `PrimaryPanel`, and fix imports, participant typing, settings lookup, locators and the research link.
- [x] Run `bun run check`, then the touched inspector spec, Memory, Box lifecycle and story-jump specs one at a time.
- [x] Set DONE and commit the follow-up.

The original enabled-only Decision contradicted “a move, not a redesign.” The corrected rules above preserve saved-data access and historical traces. Ticket 27's import-map and CSS-loading work remains outside this follow-up.

Follow-up verification after the last source/test change:

- `bun run check` passed: lint, 133 lint-rule tests, contract ownership, both typechecks, 1,492 unit tests across 172 files, and 3 e2e harness tests. Existing warnings remain.
- Then ran each spec separately, sequentially under `/tmp/ditzy-heavy.lock`: `e2e/box-inspector.spec.ts` 4 passed; `e2e/memory.spec.ts` 3 passed; `e2e/box-lifecycle.spec.ts` 7 passed; `e2e/story-jump.spec.ts` 1 passed. All 15 passed; no full-suite rerun in this follow-up.
- Trace visibility, disabled inspector access, and removal/reinsertion each failed at their new assertion before the corresponding fix, then passed. The saved-claim extension initially needed to reopen the inspector after sending a Prompt Plan; that test setup was corrected before the final checks.
- Removed enablement-dependent trace rendering, threaded conversation props, Memory's null top bar component and inspector frame, and the shared judgment formatter. Added generic host inspector buttons/frame and clearing of absent inspector selection. The SDK's `BoxClientDefinition` now uses `PrimaryPanel` and `CastParticipant`; `formatJudgment` is no longer exported. No new SDK exports.
- No component/snapshot tests or code review run. All requested follow-up items are complete; ticket 27 was not changed.
