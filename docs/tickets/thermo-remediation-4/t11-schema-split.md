# T11 — `schema.ts` back to pure table declarations

Status: DONE

Blocked By: T8

Source: issue #52, **§5 File size**.

## Problem

`src/server/database/schema.ts` (957 lines) hosts domain constants `DEFAULT_SIBLING_GENERATION_LIMIT` / `DEFAULT_CONTINUATION_STRATEGY`
(~:17-18, re-exported by the conversation barrel) and mapping helpers `fromPortraitColumns` (~:56), `toPromptChannelRow` /
`toPromptChannels` (~:551-559). Those belong to Conversation and Character. `src/server/database/database.ts` carries a raw-SQL
"fresh database" fixup inserting the author-note block: seed logic, not schema.

Also (found in T8 review): `src/server/database/chat.ts` `listChatSummaries` (~:9) is a Conversation-owned read with a raw
`FROM messages` subquery living in `database/`. Move it into the Conversation module (ADR-0013) and update its importers.

## Files owned

`src/server/database/schema.ts`, `src/server/database/database.ts`, the conversation and character modules that receive the moves, the seed module if the fixup belongs there, all importers.

## Mechanics

- **Remove:** the constants and helpers from `schema.ts`; the author-note fixup from `database.ts`.
- **Introduce:** nothing new. Constants move into Conversation, the portrait/prompt-channel mappers into Character. The fixup goes wherever
  fresh databases are actually seeded. If it must run for every fresh database (not just dev seed), find where the default
  Prompt Preset is created and put it there; record the decision in the Outcome.
- **Behavior changed:** none. A fresh database must still get the author-note block (check an e2e fixture or a test that opens a fresh DB).
- Do not create `drizzle` migrations for this; it moves TypeScript, not columns.

## TODO

- [x] Move constants to Conversation; update the barrel and importers
- [x] Move mappers to Character
- [x] Relocate the author-note fixup; prove a fresh DB still has it
- [x] Move `database/chat.ts` `listChatSummaries` into Conversation
- [x] typecheck, lint, check:contracts, `bun run test`
- [x] Commit

## Outcome

**Removed.** `schema.ts` no longer declares `DEFAULT_SIBLING_GENERATION_LIMIT` / `DEFAULT_CONTINUATION_STRATEGY` or the
`fromPortraitColumns` / `toPromptChannelRow` / `toPromptChannels` mappers, and no longer imports the `Portrait` / `PromptChannels`
wire types; the file is 958 → 932 lines and only declares tables, their column-shape interfaces, and the CHECK/index helpers.
Its two Generation Settings column defaults now state the literals `4` / `"instruction"` directly, as the other five column
defaults already did. `database.ts` no longer carries the raw-SQL author-note fixup. `database/chat.ts` is deleted; its test
moved with it.

**Introduced.** `character-library/prompt-rows.ts` holds the three storage codecs, exported from the Character barrel next to
`collectReleasedCharacterTombstones`; `conversation/internal.ts` and `commands/edit-participant.ts` import them through that
barrel. `conversation/generation-settings.ts` declares the two constants beside `DEFAULT_SAFETY_ALLOWANCE` and
`DEFAULT_CONTINUATION_INSTRUCTION`, and `history.ts`, `commands/accept-generation.ts` and the Conversation barrel import them
from there. `conversation/chat-summaries.ts` holds `listChatSummaries`, exported from the Conversation barrel; `workspace.ts`
calls it through the barrel. `prompt-preset/recipe.ts` gained `installDefaultPresetAuthorNote`, and `initializeDatabase`
calls it where it previously inlined the SQL.

**Where the fixup went.** It must run for every fresh database, not only `bun run db:seed`: every test fixture opens through
`openInitializedDatabase`, and e2e's `provision` seeds through it too, so the slot would otherwise disappear from the Default
recipe the migration chain creates. It still cannot be a migration: the `prompt_preset_block` rebuilds in 0003 and 0008 reject
the `author-note` reference, so only a post-migration step can add it. The fresh detection therefore stays in
`initializeDatabase`, and the install itself now lives in the module that owns the Default recipe (Prompt Preset `recipe.ts`)
instead of in the database bootstrap. Existing stored presets remain untouched; they gain the slot only through the explicit
Add Author Note Block action (ADR-0048).

**Behavior changed.** None. A fresh database still gets the author-note slot directly after history (verified: positions
1–8 unchanged, `author-note` at 9, `model-post-history-instruction` at 10; an existing database whose preset has no such slot
gets none on reopen).

**Verification.** `bun run typecheck` clean; `bun run lint` exit 0 (no new warnings in the touched files);
`bun run check:contracts` exit 0 (632 declarations, 151 derivations, 11 advisory matches — unchanged); `bun run test`
1357 passed, 0 failed, including `contract/author-note.test.ts` (the fresh-DB Default recipe proof),
`conversation/chat-summaries.test.ts`, `character-library/character-library.test.ts` and the prompt-preset contract suites.

**Residuals.** `database/workspace.ts` still composes the workspace read; only its Chat list read moved. The `fresh` probe in
`initializeDatabase` still names the `prompt_preset` table, because that table's existence is what says the migration chain
just built the database.

