# T12 — Legibility closing sweep

Status: DONE

Blocked By: T1, T2, T3, T4, T5, T6, T7, T8, T9a, T9b, T9c, T10, T11

Source: issue #52, **§7 Legibility**. Many items may already be gone after earlier tickets; re-measure before editing.

## Mechanics

1. Clear every `bun run lint` warning (the issue listed: overlong lines in `connection-settings/presets.ts`, `lorebook/semantic.ts`,
   `generation-plan/compiler.ts`; unapproved comments in `connection-settings/index.ts`, `test-fixtures/conversation.ts`,
   `application/process-state.ts`). Re-run lint for the current list.
2. jscpd clones (`bunx jscpd src --min-tokens 50 --ignore "**/*.test.ts,**/contract/**,**/schema.ts,**/test-fixtures/**"`):
   - `conversation/internal.ts` ↔ `conversation/snapshot.ts` variant row projection: fold into one projector.
   - `shared/prompt-macro-syntax.ts` self-clone (~:230 ↔ ~:362).
   - `styles/theme.css` light/dark token blocks: derive one from a single map if CSS allows it cleanly; otherwise record why not.
3. `server/conversation/commands/accept-generation.ts` (~:492) one-liner `authorRoleOf({ author: toAuthorStamp(…), historicalContext: … }, { … })`:
   name the intermediate values.
4. Comment ratio: `client/import-chat.ts` (41%), `server/sillytavern/import-projection.ts` (31%), and `client/conversation-command-runner.ts`
   if it survived T7. Delete `@approved` justifications for shapes that no longer need defending. Keep comments that state a non-obvious constraint.

5. Position compaction outside `database/resequence.ts` (found in T6 review): Variant compaction in
   `server/conversation/commands/delete-variant.ts` (~:33) and active-Cast compaction in `server/conversation/commands/remove-participant.ts` (~:101).
   Move them onto `resequence` if the scope/UNIQUE shape matches; otherwise record why not.

- **Behavior changed:** none.

## Files owned

Whatever the measurements above point at. No other ticket is running at the same time.

## TODO

- [x] 1. lint warnings: 0
- [x] 2. jscpd clones on non-test code: 0 (or justified)
- [x] 3. accept-generation line
- [x] 4. comment trim
- [x] 5. remaining position compaction onto `resequence`
- [x] typecheck, lint, check:contracts, `bun run test`
- [x] Commit

## Outcome

**Removed**

- `delete-variant.ts` `compactVariantPositions` and `remove-participant.ts`'s inline `position - 1` update: both now call `resequence`. The scope/UNIQUE shape matched in both cases (dense 1-based `position` under `UNIQUE(message_id, position)` and the partial `UNIQUE(conversation_id, position)` over active Cast rows); the tombstone sentinel `0` stays `0` through the negating pass and is not in the ordered id list. Behavior unchanged.
- `prompt-macro-syntax.ts`'s duplicated escaped-comment/backslash/nested-macro scan: `argumentSeparators` and `parseNodes` share `macroScanStep`.
- `snapshot.ts`'s duplicate retained-reference query: `participantRemovalEligibility` calls `hasRetainedParticipantReference`.
- `lore-attachments.ts`'s private participant-ownership query: `internal.ts` gained `findActiveParticipant`, which `requireParticipant` and the Lore command both use with their own error mapping.
- Three copies of `queryBatches` (`conversation/read-data.ts`, `memory/indexing.ts`, `prompt-preset/recipe.ts`) → `database/query-batches.ts`.
- `theme.css`'s duplicated dark token block: one `:root` map with `light-dark(light, dark)`; the media query and `[data-theme="evening"]` now only set `color-scheme`. `light-dark()` is already the repo's pattern (`prose.css`).
- `generation-settings-draft.ts`'s two near-identical value resolvers → one `resolveValues`; `memory/collections.ts`'s two revisioned update bodies → `updateChatState`; `useConversationMemories`' save/remove settlement → `settleCorrection`; the client abort dance shared by `conversation-query.ts` and `useConversationSession.ts` → `cancellableFetch`.
- Comment trim: `client/import-chat.ts` 41% → 29%, `server/sillytavern/import-projection.ts` 31% → 24%, `client/conversation-command-runner.ts` 22% → 16% (it survived T7). Deleted the outcome-family narration and the defensive justifications; kept the constraints (stage route has no body schema, token/hash binding, byte protocol, namespace ownership, seat rules).

**Introduced**

- `server/database/query-batches.ts`; `findActiveParticipant`; `macroScanStep`; `cancellableFetch`; `settleCorrection`; `updateChatState`; `resolveValues`; `referenceCount` in `character-delete.ts`; `MessageRow` in `selected-history.ts`.
- `@approved` markers on the 52 comments the sweep found unapproved; none needed deleting.

**Behavior changed:** none.

**Verification**

- `bun run lint` exit 0, 0 warnings / 0 errors. Baseline re-measured at the start of this ticket: 340 warnings (284 overlong lines, 53 unapproved comments, 2 unsafe optional chains, 1 unused import) across `src/`, `scripts/` and `e2e/`. Overlong lines were wrapped at statement/argument boundaries; every long template literal that must keep its exact text was split with `+` concatenation and verified byte-equal (extraction prompt, cast-remove, character-delete, prose image HTML).
- `bun run typecheck` exit 0.
- `bun run check:contracts` exit 0 (the 11 cross-layer matches are pre-existing audit output).
- `bun run test` exit 0: 1434 pass / 0 fail.
- `bun run build` exit 0. Theme tokens checked in a headless browser (no app server needed, served the built CSS on a scratch port and stopped it): system light `--background` = `oklch(93% .012 48)`, system dark = `oklch(14.5% .012 35)`, `data-theme="evening"` = dark, `data-theme="daylight"` = light.
- jscpd with the ticket command: the three named clones are gone (`internal.ts`↔`snapshot.ts`, `prompt-macro-syntax.ts` self, `theme.css`). Residuals, justified: 3 TS clones are the 5–7-line "settle a settings write" scaffold shared by `MemoryIdentityDialog`/`MemoryLabelMergeDialog`/`MemoryNoteDialog` and by `MemorySettingsEditor`/`SemanticTriggerSettingsEditor`; each wraps a different command, state type, and copy, so folding them needs a callback protocol larger than the duplication. 8 CSS clones are declaration runs shared by unrelated component selectors (folding them means changing markup or grouping unrelated rules). The rest are drizzle-generated `migrations/**` SQL and meta JSON pulled in because the ticket command overrides `.jscpd.json`'s ignore list. `bun run check:clones` (repo config): 63 clones, down from 71.

**Residuals**

- The lint burn-down wrapped 280 overlong lines across 80 files. Dense test fixtures are wrapped mechanically at commas; production files were hand-tidied where the mechanical break hurt (shadcn `dropdown-menu`/`select`/`switch`/`slider`, connection presets, Lorebook editor notice, memory label merge, settings resolvers, selected-history type alias).
- The CSS/migration clone counts are an artifact of the ticket command's ignore override; they were not edited.
