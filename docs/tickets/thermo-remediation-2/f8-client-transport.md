# F8 — Client transport layer is twelve copies of one function

## Status

Implemented on `fix/thermo-f8-client-transport`.

## Source

`.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F8.

## Mechanics

**Machinery removed**

- ~21 hand-written transport function bodies across `src/client/conversation.ts`,
  `src/client/lorebook-library.ts`, `src/client/prompt-preset-library.ts`,
  `src/client/character-library.ts`, and `src/client/new-chat.ts` — each a copy of the same
  `try { if (error) { 404→…; 422→… } decode; null→network } catch→network` outcome block.
- ~13 hand-written per-function outcome unions (`CommandOutcome`, `AddCharacterOutcome`,
  `SaveParticipantAsCharacterOutcome`, `MacroVariablesOutcome`, `EditMacroVariablesOutcome`,
  `GenerationDetailsOutcome<T>`, `GenerationPreviewOutcome`,
  `LoreAttachmentCommandOutcome`, `LorebookCommandOutcome`, `PresetCommandOutcome`,
  `PromptPresetImportOutcome`, `SillyTavernImportOutcome`, `PromptPresetOperationOutcome`,
  `CreationOutcome`, `StopConversationGenerationResult`, `StartConversationGenerationResult`).
- The `error.value as {...}` hand-casts in `lorebook-library.ts`.
- `lib/command-outcome.ts` entirely (the helper and its two `SAFETY` casts), absorbed rather
  than bridged; its verbatim notice constants moved to `lib/notices.ts`.
- `lib/eden.ts`'s manual `EdenResponse` restatements for the generation start/stop requests.

**Machinery introduced**

- One helper: `requestOutcome(request, schema)` in `src/client/lib/request-outcome.ts`,
  returning `{ outcome: "available"; value } | <the route's modeled wire error union verbatim> | { outcome: "network" }`.
  The route's error union is derived from the Treaty request type itself, so no per-function
  outcome vocabulary exists anywhere else. Error bodies are classified by the wire `outcome`
  tag; unmodeled bodies (Elysia's validation envelope, a server 500, a rejected fetch) are
  network-class. Consumer-facing aliases, where a callback signature needs a name, are
  `Awaited<ReturnType<…>>` derivations that cannot drift.

**Behavior**

None on the wire. The client adopts the wire word `outcome`: every client union renamed its
discriminant `status` → `outcome`, and success variants unwrap as `available` + `value`.
Call sites across `src/client/**` were migrated mechanically in the same change; no
half-migrated discriminant survives. E2E passes without any fixture or fake change.

## Notes

- The two remaining jscpd hits on `conversation.ts` are the structurally identical one-line
  start adapters (send/sibling), not surviving outcome blocks.
- Stop-route transport failures now classify as `network`; the machine's `failed` mapping and
  wording live in `useGenerationController`.
