# T2 — Server boundary and type-contract churn

Status: TODO

Blocked By: T1

Source: issue #52, finding **F11** (server-side bullets only; the client bullets are T10).

## Files owned

- `src/server/contract/memory.ts`
- `src/server/contract/conversation.ts`, `src/server/contract/prompt-preset-routes.ts`, `src/server/contract/connection-settings.ts` (route files only)
- `src/server/workflows/generate-capture.ts`
- `src/server/decision-model/index.ts`, `src/server/lorebook/semantic.ts`
- `src/server/character-library/types.ts` and every importer of the aliased names

## Mechanics

1. `contract/memory.ts`: `memoryConversationIdParams` already decodes through `numericWire` (`shared/contract/memory.ts:42`).
   Delete every one of the 18 `Number(params.id)` and use `params.id` directly.
2. One not-found spelling per route-file family. `contract/conversation.ts` mixes `readConversationOr404`, inline
   `status(404, …)` and `notFoundResponse()`; pick the one shared spelling and use it everywhere.
   `prompt-preset-routes.ts` private `respond` / `recipeResponse` helpers go if they only restate the shared presenter.
   `connection-settings.ts` 6-case switch over `settings.X(body)` collapses to a dispatch table or direct call if that is shorter and typed.
3. `workflows/generate-capture.ts`: delete the identity wrapper `participatingHistoryFromRead` (~:97) and the
   `Value.Check(conversationGenerationSettings, settings)` (~:334) that re-validates the server's own typed read.
4. Non-null assertions: `decision-model/index.ts` `.find(...)!`, `lorebook/semantic.ts` (~:333, ~:383) `chunks.at(-1)!` /
   `scores.get(...)!`. Restructure so the narrowed value is carried, not asserted.
5. `character-library/types.ts`: delete the "historical name" re-exports (`CharacterLibrarySummary as CharacterSummary`,
   `CharacterCommand as CharacterLibraryCommand`, …) and their comments. Every importer uses the wire names.

- **Behavior changed:** none.

## Rejected

- Keeping alias re-exports "for now" (AGENTS.md: no compatibility layers).

## TODO

- [ ] 1. `Number(params.id)` removal
- [ ] 2. one not-found spelling
- [ ] 3. identity wrapper + `Value.Check` deletion
- [ ] 4. server non-null assertions
- [ ] 5. character-library alias removal
- [ ] typecheck, lint, touched test files, `bun test`, `bun run check:contracts` if it exists
- [ ] Commit

## Acceptance

`grep -c 'Number(params.id)' src/server/contract/memory.ts` is 0; `grep -rn 'participatingHistoryFromRead' src` is empty.

## Outcome
