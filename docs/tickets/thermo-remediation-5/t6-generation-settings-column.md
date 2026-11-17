# T6: Generation Settings column

Status: READY

Blocked By: T5

Model: Astra 6 high writes; Sol 6.1 high fixes.

**This ticket changes stored data. Do not merge it. The owner backs up the hosted database and deploys it himself.**

Evidence: report 18, finding 1; report 17, F6.

## Problem

`conversation_generation_settings` stores a Chat's Generation Settings as 14 columns with their defaults restated. `canonicalGenerationSettings` in `src/shared/contract/generation-settings.ts` already defines and validates the same shape. Between them, `conversation/generation-settings.ts` copies field by field in four places, and a `settingsColumn` map exists that only a type reads.

## What to do

- Keep `conversation_id` and `connection_profile_id` as columns; other modules join and update on the profile id. Replace the remaining settings columns with one `settings_json`, decoded on read with `canonicalGenerationSettings`.
- Write the migration: add `settings_json`, fill it from the old columns with `json_object(...)`, drop the old columns. Run it against a database at the previous migration that holds rows with non-default values, null sampling fields and request overrides, and assert each Chat's settings read back equal. `database/migrations.test.ts` has the harness for starting at an earlier migration.
- Two reads bypass the module and fall back silently when the row is missing (`generation-gate.ts` for the sibling limit, `history.ts` for the continuation strategy). Creation always writes the row. Point both at the module's read.
- `set-generation-model` reads all settings to write two fields; give `updateConversationModelSelection` just the profile id and model id.
- Fork copies the settings row; check `fork-conversation.ts` copies the new column.

## Rejected

- Building validation errors from the schema: it changes the per-field messages the client mirrors. Keep the hand-written normalisers and their messages.
- Moving `connection_profile_id` into the JSON.

## TODO

- [ ] Migration, with the round-trip test over non-default rows
- [ ] Module reads and writes through `settings_json`
- [ ] The two direct reads and the model-selection write
- [ ] Typecheck, settings and migration tests, CI
- [ ] PR opened and left for the owner; say in the PR body that it migrates stored data and is a one-way door

## Acceptance

The migration test passes. `git grep -n 'settingsColumn' -- src` is empty. No per-field error message changed: the settings tests that assert messages pass unedited.

## Outcome
