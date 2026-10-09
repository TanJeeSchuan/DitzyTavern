# T10 — Client type contracts and memories grouping

Status: DONE

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

- [x] 1. client non-null assertions
- [x] 2. named controller prop types
- [x] 3. `memories-view.ts` + tests; MemoriesPanel uses it
- [x] typecheck, lint, `bun run test`
- [x] Commit

## Acceptance

`grep -rn 'ReturnType<typeof use' src/client` returns none of the five listed controllers.

## Outcome

**Removed**

- `GenerationSphere`'s nine `!` marks, its nine typed-array side tables, and its manual insertion sort: the 52 points are now `SpherePoint` records that carry their own circle, base coordinates, projected values, and depth; the paint loop is a stable `toSorted` over the records.
- The five exported `ReturnType<typeof useX>` types: `LorebookAttachmentsController`, `LoreMatchTesterController`, `ConversationMemoryActions`, `GenerationSettingsDraftController`, `SemanticTriggerSettingsController`.
- `MemoriesPanel`'s inline `entries`/`rank`/`byPeople` grouping and the `!` lookups inside it.
- The `.get()!` and two `state.attempt!` assertions in `src/server/updates.ts` (the finding's `updates.ts`; the client `updates.ts` never carried them).

**Introduced**

- `src/client/workspace/memories-view.ts`: `memoryPositions`, `memoryCastMembers`, `memoryEntries`, `groupEntriesByPeople`, and the `MemoryEntry`/`MemoryCastMember`/`PeopleGroup` types; `MemoryEntry` carries the claim so grouping never re-indexes.
- `src/client/workspace/memories-view.test.ts`: eight grouping/ordering cases (newest-Message-first, focus, search over claim/attribution/people, missing path entry, Cast-order and stranger/unlabelled group order, group tie-breaks).
- Named prop types at each consumer: `LorebookEditorAttachments`/`LorebookEditorTester` (LorebookEditorDialog), `MemoryActions` (MemorySource), `GenerationPanelDraft` (GenerationPanel, reused by PrimaryPanelView), `GenerationOverridesInspector` (GenerationSettingsInspector), the three editor prop signatures over `SamplingDrafts`/`BudgetDrafts`/`OverridesDrafts`, `SemanticTriggerDraftEditor` (SemanticTriggerSettingsEditor), `SemanticTriggerSettingsPreview` (ConnectionProfileList).
- `GenerationSettingsDraftStatus` and `TransmittingNamespace` in `useGenerationSettingsDraft.ts`, so the status and override-namespace shapes are named instead of inferred.
- A missing-settings-row error in `src/server/updates.ts` in place of the `.get()!` assertion.

**Behavior changed:** none. `memoryEntries` normalizes the search text itself; the panel's `searching` flag keeps the cap and empty-state copy identical.

**Verification**

- `bun run typecheck` — clean.
- `bun run lint` — no warnings in any touched client file; `src/server/updates.ts` keeps its two pre-existing overlong lines (T12's sweep).
- `bun run check:contracts` — 642 structural declarations, 11 suspicious cross-layer matches (unchanged).
- `bun run test` — 1434 pass, 0 fail across 161 files.
- `grep -rn 'ReturnType<typeof use' src/client` — only `StoryStage.tsx`'s `useConversationSession`/`useGenerationController`/`usePreviewController` (T3's file, not in this ticket's five).

**Residuals**

- No manual browser check: the change is type contracts plus a pure extraction, `e2e/memory.spec.ts` covers the panel, and the orchestrator runs e2e once at the end.
