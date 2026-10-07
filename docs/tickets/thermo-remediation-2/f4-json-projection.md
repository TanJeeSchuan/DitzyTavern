# The closed JSON projection tax

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`,
finding F4 (the "closed JSON projection" tax), with the folded F13
fragments (the duplicated prompt-preset summary projection, the double
drizzle handle + transaction in `executePromptPresetCommand`, the
`GenerationRuntimeState`/`MutableRuntimeState` pair, and the ten-parameter
`expandInto`).

## Goal

Hand-written field-by-field copies existed only to satisfy
`GenerationJsonValue` or a wire type; each was a second place to edit when a
field was added. The prompt-context / prompt-inspection / connection-identity
projections in `generate-capture.ts` duplicated an entry projection and hid an
identity wrapper and an alias; `evidenceFor` copied the lore entry and match
structures by hand; the match-test route copied the same match structure a
second time and kept a verbatim local copy of the stale-conversation conflict
response; `replayCarriedColumns` restated twenty row columns after nine
exclusions; the slot discriminant was projected three times across
`recipe.ts`/`library.ts`; two decoder tables were restated key-by-key right
below their declarations. After this ticket a JSON-compatible record is typed
at the point it is built and passed through, a decoder table is consumed by
one mapped expression, and every surviving projection has a distinguishing
job (envelope strip, subset selection, flatten, or closed-value
normalization).

## Mechanics

**Machinery removed**

- `generate-capture.ts`: the identity wrapper `generationSettingsJson`
  (returned its argument unchanged), the alias `connectionJson` (forwarded to
  `connectionIdentityOf`), and the hand `promptContextJson` entry projection
  (restated `PromptContextEntry` field-by-field). `capturedAcceptanceFields`
  passes the writing context and the Effective Generation Settings through —
  both are already closed JSON values (TypeBox `Static` type aliases carry
  implicit index signatures) — and calls `connectionIdentityOf` directly.
  `promptInspectionJson` keeps its distinguishing job (the active-only budget
  subset) but its `omittedContext` map was the same entry projection and now
  passes the budget's own entries through. The local
  `PersistedGenerationSettings` mapped type and the `GenerationSettingsField`
  import went with them.
- `lorebook/evaluation.ts`: `evidenceFor`'s ~50-line copy of the entry, the
  match conditions, and every expression array. The book projection survives
  as an envelope strip (drops `entries`, which is carried beside it), the
  stored entry passes through, and `satisfies GenerationJsonValue` at the
  build point carries the closed-JSON guarantee the copy used to provide
  incidentally. `semanticEvidence` survives: it closes the optional
  `fallbackReason` to `null` exactly as the match stores it — a pass-through
  would omit the key and change the persisted bytes.
- `contract/lorebook-routes.ts`: the match-test route's two-step build
  (intermediate `result`, then a full re-projection of every condition) is
  one flatten — the match spreads onto the entry item. The inner
  readonly→mutable array conversion survives as the one cast validated by the
  declared `loreMatchTestResponse` response schema (Elysia infers the treaty
  client's types from this payload, so the schema-owned mutable arrays must
  hold — a plain spread typecheck-poisoned `LorebookPanel`/`LoreAttachmentEditor`
  and was rejected).
- `contract/lorebook-routes.ts`: the local `staleConversationConflictResponse`
  copy of `contract/conversation.ts`'s file-private builder — deleted; the
  canonical `staleConversationResponse` is exported from
  `contract/conversation.ts` and the Conversation-owned Lore attachment
  commands call it (same 409 payload, same key order, same 404 fallback).
- `conversation/commands/active-generation.ts`: `replayCarriedColumns`'s
  twenty-column restatement — the exclusions are now the single source of
  truth (rest-destructure; the exclusion names are type-checked against the
  row by destructuring validity) and every other column carries mechanically,
  in the same key order. Also the two in-file clone pairs jscpd flagged:
  the provisional Variant existence read (`provisionalVariantRow`) and the
  Active Generation read-or-throw prelude (`requireActiveGeneration`) exist
  once and serve terminal persistence, removal, and the stop transition with
  unchanged error messages.
- `prompt-preset/library.ts`: the duplicated summary select + row-to-summary
  map (`presetHeaderSelection` + `summaryOf` shared by the list read and the
  in-transaction `requireSummary`); the create/duplicate header-insert
  prelude (`insertPresetHeader`); the duplicate command's block-select column
  list (the shared `promptPresetBlockSelection` in `recipe.ts`, which the
  recipe reader derives from by adding the occurrence id back); and the
  double connect + transaction — one drizzle handle and one transaction now
  serve every command this executor accepts.
- `prompt-preset/library.ts`: `readNativePromptPreset`'s three-branch
  re-projection of the slot discriminant — the recipe reader's output is
  already the canonical closed slot shape, so the native export is one
  envelope strip (drop the occurrence id).
- `conversation/generation-details.ts` and `shared/generation-provenance.ts`:
  both `safeGenerationSettings` and `provenanceSettings` restated every key
  of an existing decoder table to call it. Each is now one mapped expression
  over the table (its own keys, in its declaration order), so a new canonical
  field still touches exactly one line — the table — and cannot be forgotten
  in the projection.
- `workflows/generation-runtime.ts`: `MutableRuntimeState` restated every
  field of `GenerationRuntimeState` without `readonly`; it is now one
  `-readonly` derivation from the published state.
- `prompt-compiler/compiler.ts`: `expandInto`'s ten positional parameters are
  one parameter object; the three call sites read as the request they make.

**Machinery introduced**

- Nothing beyond type annotations, the two Safety-commented casts that
  restate what the deleted fresh-literal copies used to prove (the match-test
  wire shape and the decoder-table record shape), the exported
  `staleConversationResponse` (hoisted canonical builder), the shared
  `summaryOf`/`insertPresetHeader`/`semanticEvidence` one-projection helpers,
  and the two in-file probes in `active-generation.ts`.

**Behavior**

None intended and none observed: same wire bytes (every pass-through
preserves key order, and `fallbackReason`/`id` null-normalization survives
where the persisted bytes depend on it), same errors, same transaction
boundaries, same response shapes. The one cosmetic delta is on an
unreachable defensive path: the header-insert failure message of
`importNativePromptPreset` unifies to the create wording ("The Prompt Preset
could not be created.") — the insert's returning row cannot be undefined, no
test or route asserts the message, and the reachable error vocabulary is
unchanged. Full suite identical to base.

## Out-of-scope remainders (inspected, not converted)

- `generation-details.ts` ↔ `conversation/internal.ts` select-chain clone
  (jscpd): the partner lives in `internal.ts`, the F6 probe seam this ticket
  must not touch; the shared read cannot move without crossing that
  boundary.
- `contract/prompt-preset-routes.ts`, `prompt-preset/blocks.ts`,
  `prompt-preset/sillytavern.ts`, `conversation/prompt-preset.ts` jscpd
  flags: not cited by F4 and `prompt-preset-routes.ts` is not owned here.
- `src/styles/story.css` (1,232 lines) already exceeded the 1,000-line
  production-file guard at base; styles are outside this ticket's file list.
  `generate-capture.ts` — the file to watch — went 857 → 828.

## Verification

- `bun run typecheck` — exit 0.
- `bun run lint` — exit 0; 41 warnings, identical count to base, zero new.
- `bun run test` — 1305 pass / 0 fail.
- `bun run check:contracts` — exit 0; 607 structural declarations (base 608),
  same 11 suspicious cross-layer matches as base.
- `bun run test:e2e` — 34 passed.
- `bun run check:clones` — 72 clones (base 79); the flagged
  `prompt-preset` pair (library.ts ↔ recipe.ts instruction branch), the
  generate-capture entry-projection pair, and both active-generation pairs
  are gone; the library selection consts introduced en route were collapsed
  into one derived declaration so they carry no new clone.
- `rg -n 'generationSettingsJson|connectionJson' src/server/workflows/generate-capture.ts`
  — zero matches.
- `rg --files src | xargs wc -l` — no production file this ticket touched
  reaches 1,000 lines.
