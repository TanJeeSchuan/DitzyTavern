# Generation attempt kind dispatched in nine places

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F3.

## Goal

One `GenerationTarget` union for the closed `send | continuation | sibling` vocabulary, one capture function, and one lifecycle policy — instead of four parallel discriminated unions, twelve branches, six near-duplicate capture functions, and six wrappers.

## Ownership

- `src/server/workflows/generate-capture.ts`, `generation-preview.ts`, `generate.ts`, `index.ts`
- `src/server/application/generation-coordinator.ts`
- `src/shared/contract/conversation-schema.ts` (the `GenerationPreviewBody.kind` source vocabulary)
- Direct import sites and focused tests forced by the signature changes

## Mechanics

Removed:

- Three re-declared discriminated unions: `PreparationKind`, the tail of `PrepareGenerationInputs`, `PreviewSnapshotKind`, plus the three-variant `GenerationPreviewCapture` wrapper.
- Six near-duplicate capture functions (`capture{Send,Continuation,Sibling}GenerationAsync`, `capture{Send,Continuation,Sibling}GenerationPreview`) and the `buildPreviewCaptureAsync` switch, dissolved into one `captureGeneration(database, target, options)` and one `captureGenerationPreview(context, preview, target)`.
- Six wrappers: the three `startServerOwned{Send,Continuation,Sibling}Generation` functions and the three `GenerationCoordinator.start{Send,Continuation,Sibling}Generation` methods, collapsed to one generic each (`startServerOwnedGeneration`, `GenerationCoordinator.startGeneration`). Gone, not aliased.
- The unreachable second Continuation eligibility validation in the capture path; eligibility is validated once, in `prepareGenerationInputsSnapshot`.
- The `reuseHumanMessageId` recomputation: the snapshot retains the validated fact instead of `captureSendGenerationAsync` re-deriving it through `sendReuseTargetOf`; `SendReuseTarget` (its `variantId` had no consumer) is deleted.
- The duplicate "pending human text is already the last selected Message" invariant: `pendingHumanText` is computed once and fed to both the lore and memory passes.
- F10 fold-in: `GenerationCaptureInput` and `PrepareGenerationInputsBase` (the same shape declared a second and third time) dissolved into one `GenerationCaptureOptions`.
- `GenerateSiblingVariantInput` no longer restates every field of `GenerationAttemptInput` and no longer uses an inline `import("../model-client/types").ModelFetch`.
- Unused exports demoted (`GenerationDerivation`, `compilePlanFrom`, `toCompilerDefinition`, the JSON projections).

Introduced:

- `GenerationTarget` / `GenerationTargetKind` / `GenerationTargetFor<K>` beside the wire `generationPreviewBody`.
- `CapturedGenerationFor<K>`: the shared capture projection plus exactly the lifecycle facts each kind's acceptance commands read.
- One module-level lifecycle policy table (target builder, accept, request, optional terminal data) run by one `runGenerationLifecycle` with the byte-identical preview/non-preview fork lifted into it.

Behavior: none.

## Work

- [x] Unify the four parallel kind unions onto the wire vocabulary.
- [x] Collapse the three async capture functions into `captureGeneration`.
- [x] Collapse the three preview capture functions into `captureGenerationPreview`.
- [x] Lift the preview fork into `runGenerationLifecycle`.
- [x] Collapse the three server-owned wrappers and the three coordinator methods to one generic each.
- [x] Delete the unreachable second Continuation eligibility validation.
- [x] Store the snapshot's validated `reuseHumanMessageId` / preceding ids instead of recomputing.
- [x] Compute the pending-human invariant once.
- [x] Dissolve `GenerationCaptureInput` and `PrepareGenerationInputsBase` (F10).
- [x] Extend `GenerateSiblingVariantInput` instead of restating fields.
- [x] Verification: typecheck, lint, tests, contracts, e2e; no production file ≥ 1,000 lines.

## Acceptance

- The kind vocabulary is declared once, on the wire.
- One capture function per entry path; no per-kind capture copies.
- No compatibility wrappers; the old names are gone.
- `rg 'PreparationKind|PreviewSnapshotKind' src/server` and `rg 'startServerOwned{Send,Continuation,Sibling}Generation' src/server` come back empty.
- Observable behavior, error precedence, and provider-call sequence unchanged (e2e scripted fakes still match).

## Leftover risks (pre-existing, out of scope)

- `prepareGenerationInputsAsync`'s semantic lore re-evaluation passes `pendingHumanText` unconditionally for `send` (not gated on reuse) while the snapshot pass is gated. Not flagged by the audit; left as-is to keep behavior unchanged.
- `ModelClientGenerationInput.assistantPrefill` is now derived by the adapter from the compiled plan and no longer set by the workflows; the optional field and its suffix-mismatch guard remain in `model-client` (another area) and no caller sets it.
