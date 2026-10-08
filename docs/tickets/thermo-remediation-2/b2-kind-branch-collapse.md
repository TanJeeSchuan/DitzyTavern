# Generation capture and lifecycle kind branches collapsed onto policy tables

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F3 residue (B2 batch 2). The F3 ticket (`f3-generation-kind.md`) collapsed the unions, captures, and wrappers; this ticket finishes the residual kind-dispatch inside the shared capture and lifecycle functions.

## Goal

The shared preparation and lifecycle functions read one policy row per attempt kind instead of branching on it: no `input.kind ===` ladders inside `prepareGenerationInputsSnapshot` / `prepareGenerationInputsAsync` / `captureGeneration`, one declared lifecycle policy surface instead of three sibling consts, and one facts declaration instead of per-kind fact shapes restated on the preparation member and the captured Generation.

## Ownership

- `src/server/workflows/generate-capture.ts`, `generate.ts`
- `src/server/workflows/generation-preparation-fingerprint.test.ts` (fixture gains the carried fields)

Out of scope (untouched): `src/server/conversation/**` (its participant-removal test and the acceptance commands), `src/server/contract/**` (the routes export `prepareGenerationInputsSnapshot`'s merged single-object call shape via `decision-models.test.ts`), `src/server/sillytavern/import.test.ts` and `src/server/conversation/participant-removal.test.ts` (unowned tests import the three exported lifecycle entry points, so remove-the-entry-points was not viable).

## Mechanics

- One `capturePolicies` table keyed by `GenerationTargetKind` (`GenerationCapturePolicy<K>` rows):
  - `selectsMessageId` — the Message whose Variant is the attempt's selected-history read point (only Sibling).
  - `assertEligible` — Continuation's active-generation guard, Sibling's swipe-eligibility guard, thrown where they were thrown before.
  - `intent` — the per-kind `GenerationIntentFor<K>` mapping; effective settings and plan compilation read the one derivation.
  - `memberFields` — the attempt's own target fields plus its lifecycle facts plus the pending-human decision, derived once where their reads are validated (the Continuation terminal validation and its preceding-entry reads moved here from the dissolved `switch`).
  - `semanticPendingHumanText` — the asynchronous semantic pass's human text, left ungated by the reuse decision exactly as F3 shipped it (behavior preserved; see F3's own leftover-risk note).
- The pending-human invariant and the attempt's carried intent ride the preparation member (`GenerationPreparationCarried`), so the control-context extension in `captureGeneration` reads `pendingHumanText === undefined` instead of branching and the compile reads `preparation.intent`.
- One `GenerationCaptureFacts<K>` mapping declares each kind's acceptance facts once and is shared by the preparation member and `CapturedGenerationFor<K>`.
- "Three lifecycle functions" interpretation: the three lifecycle policy consts (`sendLifecycle`, `continuationLifecycle`, `siblingLifecycle`) fold into one `generationLifecyclePolicies` table selected by the one runner `runGenerationLifecycle`. The three exported entry points (`sendThroughProvisionalTailGeneration`, `continueGeneration`, `generateSiblingVariant`) remain — not removed; unowned tests import two of them — and shrink to one-line row selectors. The runner reads `onAccepted` (and `preview`) from its input instead of restating `input.onAccepted` at every entry.
- The `startServerOwnedGeneration` structural dispatch (`"content" in` / `"messageId" in`) stays: the wire-level `GenerationStartInput` union carries no `kind` field and the routes building it are out of scope. Third occurrence of `.kind ===` in `generate-capture.ts` is `block.kind ===` (prompt block discrimination), not attempt-kind dispatch.

Behavior: none.

## Work

- [x] Dissolve the five `input.kind ===` branches in `prepareGenerationInputsSnapshot` onto the capture policy table.
- [x] Dissolve the `prepared.kind === "send"` semantic-pass re-evaluation onto `semanticPendingHumanText` (kept ungated, behavior preserved).
- [x] Dissolve the `switch (preparation.kind)` capture assembly onto the member spread.
- [x] Remove the `generationIntentFor` overload ladder; the rows carry `GenerationIntentFor<K>`.
- [x] Declare the per-kind facts once (`GenerationCaptureFacts<K>`), removing the duplicated inline fact shapes on both the member and the captured Generation.
- [x] Fold the three lifecycle policy consts into `generationLifecyclePolicies`; the runner takes `onAccepted` from its input.
- [x] Verification: typecheck, lint, tests (1,336 pass), contracts, e2e (36 pass); `rg -c 'input.kind ===' generate-capture.ts` = 0.

## Acceptance

- The capture and lifecycle flows branch on the policy rows, not the attempt kind.
- The per-kind validity narrows at the rows: each row's functions read exactly its kind's fields, and TS keeps the merged flow's per-kind facts (continuation's carried intent) without a per-kind switch.
- Observable behavior, error precedence, fingerprint freshness semantics, and provider-call sequence unchanged (scripted fakes still match every Prompt Plan).

## Leftover risks

- **Size**: `generate-capture.ts` lands at 898 lines, not materially below 828. The policy table and its declared interface/intent/state/awaited-projection machinery is ~150 declared lines against ~90 removed switch/ladder lines plus ~50 removed duplicated fact declarations. Compressing further would mean mushing the rows' comments below the repo's annotation conventions or dropping the state/alias typing that keeps the generic flow type-sound. Combined with `generate.ts` (395, its sibling policy consts merged into the table), the workflows stay well under the 1,000-line cap.
- The snapshot's carried `intent` and `pendingHumanText` ride the fingerprint string. Both are pure functions of already-fingerprinted settings and target fields, so the fingerprint stays self-consistent (the recorded value and the freshness recompute use the same shape); its exact string changes, which is invisible outside the process-local preview records.
- `CapturedGenerationFor<K>` gained a top-level `intent` field for every kind (Send's is always `undefined`, Sibling's `{ type: "sibling" }` matches what the acceptance command already hardcodes). No acceptance command changed what it reads or writes.
- One full-suite e2e flake was observed once on `generation.spec.ts:99` (edited Prompt Plan) under the 36-test swarm and could not be reproduced: focused runs 3/3 and two consecutive full-suite runs green. UI timing test, not a fingerprint or capture regression.
