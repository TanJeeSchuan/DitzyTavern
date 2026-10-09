# T6 — Prompt Preset block ops on one `withRecipe`; one `resequence`

Status: TODO

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

- [ ] `resequence` in `database/`; migrate lorebook reorder, lorebook delete-entry, prompt-preset renumber
- [ ] `withRecipe`; rewrite the seven block ops on it; one read per op
- [ ] `listLorebooks` count group-by
- [ ] `attachments.ts` single connection, drop scope re-validation
- [ ] typecheck, lint, check:contracts, `bun run test`
- [ ] Commit

## Acceptance

`grep -c 'requireRecipe(readPromptPresetRecipe' src/server/prompt-preset/blocks.ts` ≤ 1; no `65536` and no negative-position trick remain.

## Outcome
