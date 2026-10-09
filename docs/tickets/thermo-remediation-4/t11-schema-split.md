# T11 — `schema.ts` back to pure table declarations

Status: TODO

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

- [ ] Move constants to Conversation; update the barrel and importers
- [ ] Move mappers to Character
- [ ] Relocate the author-note fixup; prove a fresh DB still has it
- [ ] Move `database/chat.ts` `listChatSummaries` into Conversation
- [ ] typecheck, lint, check:contracts, `bun run test`
- [ ] Commit

## Outcome
