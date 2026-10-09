# T6 — Prompt Preset block ops on one `withRecipe`; one `resequence`

Status: DONE

Blocked By: T4

Source: issue #52, findings **F5** (blocker) and **F6**, plus the lorebook bullet of **§6 Modularity**.

## Problem

- F5: every op in `src/server/prompt-preset/blocks.ts` calls `requireRecipe(readPromptPresetRecipe(database, presetId), presetId)`
  before **and** after the write (8 sites); `refreshSelectedMemoryTails` reads it a third time to diff `hasEnabledMemorySlot`.
  `move`, `remove`, `duplicate` and the catch-all each call `renumber` with their own ordered-id derivation. Three of the seven
  ops rebuild the insert `writePromptPresetBlock` already encapsulates.
- F6: three bespoke position-renumbering routines for "re-sequence `position` under a UNIQUE constraint":
  `lorebook/library.ts` (~:290, negative-position trick), the inline delete-entry renumber loop in the same file (~:324),
  `prompt-preset/blocks.ts` (~:119-126, `+65536` trick). `listLorebooks` (~:144) has an N+1 (`.all().length` per book).
- §6: `lorebook/attachments.ts` `readLorebookAttachmentState` reconnects three times; `participantScope` / `requireScope`
  re-validate a string the TypeBox `LoreAttachmentScope` union already constrains.

## Files owned

`src/server/prompt-preset/blocks.ts`, `src/server/lorebook/library.ts`, `src/server/lorebook/attachments.ts`,
one new helper under `src/server/database/`, and their tests.

## Mechanics

- **Remove:** the before/after double read (compute the memory-slot delta from the one post-write read plus the op's own input);
  per-op renumber bookkeeping; the three restated inserts; two of the three renumber routines; the `listLorebooks` N+1;
  the triple reconnect and the scope re-validation in `attachments.ts`.
- **Introduce:** `withRecipe(presetId, (db, recipe) => mutation)` that reads once, applies, renumbers once, returns the fresh recipe
  (ops become 3–6 line bodies); `resequence(db, table, scopeColumn, scopeId, orderedIds)` in `src/server/database/`;
  `listLorebooks` uses a `count()` group-by.
- **Behavior changed:** none. Same rows, same positions, one fewer read per op. Existing tests are the safety net; add a test for
  `resequence` only through a real caller (reordering under the UNIQUE constraint), not as a shape test.
- Use the shared revision guard from T4; do not reintroduce module-local revision checks.

## TODO

- [x] `resequence` in `database/`; migrate lorebook reorder, lorebook delete-entry, prompt-preset renumber
- [x] `withRecipe`; rewrite the seven block ops on it; one read per op
- [x] `listLorebooks` count group-by
- [x] `attachments.ts` single connection, drop scope re-validation
- [x] typecheck, lint, check:contracts, `bun run test`
- [x] Commit

## Acceptance

`grep -c 'requireRecipe(readPromptPresetRecipe' src/server/prompt-preset/blocks.ts` is 0; no `65536` and no negative-position trick remain.

## Outcome

- **`resequence`:** `src/server/database/resequence.ts` takes `(db, table, scopeColumn, scopeId, orderedIds)` exactly as sketched. One
  bulk negating pass moves the whole scope out of the positive range, then one assignment per id writes the dense 1-based order. SQLite
  rejects a table-qualified column in a SET target, so the target is named through `sql.identifier("position")` while expressions keep
  the qualified column; the helper's type is the `{ id, position }` pair every call site's table already has. It replaced the
  prompt-preset `+65536` trick, the lorebook reorder's negative-then-positive loop, and the lorebook delete-entry compaction loop.
  Neither caller re-reads an ordered-id list it already holds: the Prompt Preset order comes from the recipe `withRecipe` read, and the
  Lorebook order comes from the book the revision guard read (delete-entry filters the deleted id out of `book.entries`).
- **`withRecipe`:** reads the recipe once before the mutation, lets the mutation return the new dense order only when it moved one,
  then takes the single post-write read that is both the response and the Memory-toggle diff, so `refreshSelectedMemoryTails` no longer
  reads a third time. The occurrence-existence check became `requireOccurrence(recipe, …)` over that read. Every op is now a small body
  that only does its own work over one boundary; the two former transaction helpers (`writePromptPresetBlock`, `renumber`) and
  `orderedIdsOf` are gone. Stale block edits still throw `PromptPresetBlockNotFoundError`, move bounds still throw
  `InvalidPromptPresetOperationError`, and `savePromptPresetBlockPatches` still validates every patch before the first write.
  Reads per op drop from three to two (an empty patch batch already cost two).
- **`listLorebooks`:** one `count()` group-by keyed by `lorebook_id` replaces the per-book `.all().length`, with a 0 default for books
  that have no entries.
- **`attachments.ts`:** `readLorebookAttachmentState` now opens one connection and reaches `readLorebookAttachmentEligibilityFrom` /
  `readLoreSettingsFrom` (the exported one-argument-to-connection wrappers stay for the evaluation seam and tests). `requireScope` is
  deleted; `participantScope` is deleted too, with the stored Character/Participant `scope` columns typed
  `$type<Exclude<LoreAttachmentScope, "chat">>()` in the schema so reads are already the union member the CHECK constraint enforces
  (type-only change, no migration). That removed `ownerAttachmentOf`, which existed only to re-validate each read row.
- **Test:** `library.test.ts` drives the new seam only through real callers — an `executeLorebookCommand` reorder of the last entry into
  position 1 (the target slot is still occupied, so a single-pass renumber violates the UNIQUE index), the following delete's dense
  compaction, and the `listLorebooks` counts before and after. No shape test on `resequence` itself.
- **Behavior changed:** none on the wire; same rows, same positions, same error classes and messages. The shared T4 `guardRevision`
  seam is untouched and no module-local revision check was introduced.
- **Gates:** `bun run typecheck` 0 errors; `bun run lint` exit 0 (only pre-existing warnings); `bun run check:contracts` exit 0
  (11 pre-existing suspicious cross-layer matches); `bun run test` 1358 pass / 0 fail. Acceptance greps: 0 and none.

Review fix round 1 (Codex gpt-6.1-sol): F5's insert consolidation was unfinished — `addPromptPresetBlock`,
`addPromptPresetInstruction`, and `duplicatePromptPresetBlock` still built and inserted a block row each. One
`insertOccurrence(db, presetId, position, { reference, enabled, role?, name?, content? })` helper now constructs the stored
row for all three and returns its id: it owns the preset id, the storage split (history stores no role; only an authored
instruction stores a name and text), the outgoing role a new slot starts with (`defaultOutgoingRoles`, `system` for an
authored instruction), and the id read. `addPromptPresetBlock` supplies `{ reference, enabled: true }`,
`addPromptPresetInstruction` its blank name and text, `duplicatePromptPresetBlock` the occurrence it read. Same rows, same
positions, same id order; the duplicate's unreachable "could not be stored" guard left with its scaffold. Contract coverage
confirmed, no test added: add-reference and duplicate in `prompt-preset-recipe.test.ts` ("saved rearrangement, toggles,
duplicates, additions and removals…") plus the author-note placement tests, and add-instruction through
`POST /api/prompt-presets/:presetId/instructions` in `prompt-preset-authored-instructions.test.ts` and its macro suite.

Re-verification after round 1: `bun run typecheck` exit 0; `bun run lint` exit 0 (348 pre-existing warnings; the one in
`blocks.ts` is the same unapproved-JSDoc warning as before this round, at its shifted line); `bun run check:contracts` exit 0
(628 structural declarations, 151 `Static<typeof Schema>` derivations, 11 advisory cross-layer matches);
`bun test src/server/contract` 369 pass / 0 fail; `bun test src/server/lorebook` 25 pass / 0 fail.
