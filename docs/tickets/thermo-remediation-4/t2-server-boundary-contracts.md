# T2 — Server boundary and type-contract churn

Status: DONE

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

- [x] 1. `Number(params.id)` removal (plus the two siblings on the same numericWire contracts: `Number(params.variantId)`, `Number(params.runId)`)
- [x] 2. one not-found spelling (each owned route file now has exactly one: `notFoundResponse()` via `./responses`)
- [x] 3. identity wrapper + `Value.Check` deletion
- [x] 4. server non-null assertions
- [x] 5. character-library alias removal
- [x] typecheck, lint, touched test files, `bun test`, `bun run check:contracts` if it exists
- [x] Commit

## Acceptance

✔ `grep -c 'Number(params.id)' src/server/contract/memory.ts` is 0; also 0 for `Number(params` anywhere in that file.
✔ `grep -rn 'participatingHistoryFromRead' src` is empty.

## Outcome

Mechanics notes that refined the ticket while implementing:

- The one not-found spelling is `notFoundResponse()` from `contract/responses.ts`: conversation.ts's `readConversationOr404` wrapper (which already routed to it) is collapsed, the two inline `status(404, …)` call sites use it directly, and connection-settings.ts's discovery route also moved off its private `status(404)`/`status(422)` spellings onto the shared `notFoundResponse`/`invalidResponse` presenters.
- `contract/connection-settings.ts`: the `settings[body.type](body)` dispatch-table idea does not typecheck (wire `type` is kebab-case, method names camelCase; TS rejects calling a distributed union of signatures with a union argument), so the six arms return the direct call inline — the `let result` + `break` ceremony is gone and each case is one typed line.
- prompt-preset `respond`/`recipeResponse` deleted; all 11 call sites carry the same direct `try/presentDomainError` spelling as every other route file.
- decision-model: `resolveDecisionSelection`'s `.find(...)!` became a find + explicit stale-profile throw reusing the validator's message; `requestDecisions` keeps the answer-set length guard, while the per-id pairing loop narrows `questions[id]`/`answers[id]` for real — the two spellings each own one failure mode (added vs omitted answers), no assertion and no dead branch.
- lorebook/semantic: `sceneChunks` carries the open chunk in a local, and `matches` is built by pairing each trigger item id with its validated score (a missing score throws the malformed Semantic Trigger answer, reaching the catch path's fallback reason).
- character-library: the two historical-name re-exports became canonical pass-throughs (`CharacterLibrarySummary`, `CharacterCommand`); importers (execute/index/snapshot, `sillytavern/staged/preview.ts`, `contract.test.ts`) renamed in place. Client-side local aliases are T10's bullets, untouched.

Full verification after the change: `bun run typecheck` clean, `bun run lint` clean (pre-existing warnings only), `bun run check:contracts` unchanged, `bun test src` 1353 pass / 0 fail, `bun run test:e2e:harness` 3 pass / 0 fail.
