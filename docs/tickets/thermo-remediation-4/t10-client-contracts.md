# T10 — Client type contracts and memories grouping

Status: TODO

Blocked By: T9c

Source: issue #52, finding **F11** (client bullets) and the client bullet of **§6 Modularity**.

## Files owned

`src/client/story/GenerationSphere.tsx`, `src/client/updates.ts`, `src/client/workspace/{useLorebookAttachments,useLoreMatchTester,useConversationMemories,useGenerationSettingsDraft}.ts`,
`SemanticTriggerSettingsEditor` (locate it), `MemoriesPanel.tsx` (locate it), a new `memories-view.ts` next to the other client reducers, and consumers of the exported controller types.

## Mechanics

1. Non-null assertions: `GenerationSphere.tsx` (9 on typed arrays), `updates.ts` `.get()!` / `state.attempt!`. Restructure to carry the narrowed value.
2. Exported `ReturnType<typeof useX>` controller types (`useLorebookAttachments`, `useLoreMatchTester`, `useConversationMemories`,
   `useGenerationSettingsDraft`, `SemanticTriggerSettingsEditor`): replace each with a named type of the 3–5 fields the consumer actually uses.
3. `MemoriesPanel.tsx` (~333 lines): lift the pure grouping (`entries`, `rank`, `byPeople`) to `memories-view.ts`; test it there
   with real grouping cases (not a shape test). Re-wrap the 200-char lines in `useConversationMemories.ts`.

- **Behavior changed:** none.

## TODO

- [ ] 1. client non-null assertions
- [ ] 2. named controller prop types
- [ ] 3. `memories-view.ts` + tests; MemoriesPanel uses it
- [ ] typecheck, lint, `bun run test`
- [ ] Commit

## Acceptance

`grep -rn 'ReturnType<typeof use' src/client` returns none of the five listed controllers.

## Outcome
