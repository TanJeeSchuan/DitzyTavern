# Memory settings become Box data

Status: TODO

Blocked By: none

Source: GitHub #68 "Settings → `*_data`".

## Goal

Memory keeps its settings where every other Box keeps its own: global settings in `library_data` and per-Chat settings in `conversation_data`, both under the `box:memory` namespace. The two Memory settings tables and Memory's `remove` hook go away.

## Decisions

- `memory_settings` becomes one `library_data` value under `box:memory`, written through the revision-guarded `putBoxData` path (`src/server/conversation/commands/put-box-data.ts`), the way `src/server/box/decision-settings.ts` stores one JSON key.
- `memory_settings.enabled` is removed. Memory runs in a Chat when the Memory Box is enabled there. **Behavior change:** there is no global Memory switch; the fan-out over every Chat in `src/server/memory/settings.ts` goes.
- The Decision Model selection (`decision_profile_id`, `decision_model`, `decision_state_token_limit`) moves with the other settings for now. Ticket 22 moves it to the host's per-Box Decision selection, when Memory starts digesting.
- `conversation_memory_settings` becomes `conversation_data` values under `box:memory` (allowance, note, identities, label merges). Removing the Box already clears its namespace (`set-box-state.ts`), so `memoryBox.remove` and `conversationMemorySettingsTable`'s export from `src/box-sdk/server.ts` go.
- `conversation_data` has no revision column. If a current client flow relies on a stale-write guard from `revision` or `label_revision`, add the guard to the host's `conversation_data` write path generically, not inside Memory's values. Otherwise drop the revisions.
- Existing data need not be migrated. Drop both tables in the migration.

## Work

- [ ] Move the global settings to `library_data` and remove the `enabled` flag and its fan-out.
- [ ] Move the per-Chat settings to `conversation_data` and remove `memoryBox.remove` and the SDK table export.
- [ ] Update the routes, `src/client/memory-settings.ts`, `MemorySettingsEditor.tsx`, the allowance, note, identity and merge dialogs, and the e2e helpers (`e2e/server.ts`, `e2e/fixtures.ts`) that write `memory_settings` directly.
- [ ] Drop `memory_settings` and `conversation_memory_settings` with a migration.
- [ ] `e2e/memory.spec.ts`, `e2e/box-lifecycle.spec.ts` and `e2e/story-jump.spec.ts` pass.
- [ ] Run `bun run check` and the affected e2e specs.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No code reads or writes `memory_settings` or `conversation_memory_settings`.
- The Memory Box declares no `remove` hook, and `src/box-sdk/server.ts` exports no Memory table.
