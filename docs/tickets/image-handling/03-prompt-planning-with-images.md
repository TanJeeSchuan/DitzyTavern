# Prompt planning with Images

Status: DONE

Blocked By: 02-images-in-writing

Source: `docs/specs/image-handling.md`, User Stories 35–43, Implementation Decisions 8–11 and 14; ADR-0046.

## Goal

Make Prompt Plans aware of Images: resolve References after macro expansion, give text consumers anchors, estimate and place Images, and show them in inspection.

## Ownership

- `src/server/prompt-compiler/`, `src/server/generation-plan/`, and Active Generation persistence
- Text-consumer inputs in `src/server/lorebook/` and `src/server/memory/`
- `src/server/conversation/generation-settings.ts` and its client editor
- `src/client/PromptPlanPreviewPanel.tsx` and `src/client/GenerationDetailsPanel.tsx`

## Work

- [x] Resolve References after Prompt Macro expansion across the Prompt Plan. Plans, checkpoints, and Active Generation records hold References only, and Active Generation records are registered in the reference index.
- [x] Route the Lore Scan Window, Semantic Trigger judging, Memory extraction, embeddings, and the Estimation transcript through the anchor projection.
- [x] Add each sent Image's `w·h/750` cost, after notionally fitting its long edge to 1568 px, to its entry, keeping whole-entry eviction.
- [x] Add the Repeated Image Placement Generation Setting (first, last, every; default last), applied after eviction, with its trade-offs explained in the UI. Expose which References send their Image in the plan so the Model Client does not recompute it.
- [x] Show Images in Prompt inspection with `ProseEditor`, allow editing an inspected plan with Images, and warn about missing Images in inspection and Generation Details.
- [x] Test the estimate, eviction, placement values, macro-produced References, missing warnings, and the absence of hashes in text-consumer input, per spec Testing Decisions 4–6. Verify inspection and the setting manually with playwright-cli.
- [x] Run focused tests, typechecking, and the full test suite.
- [x] Run `/code-review` and resolve its findings.
- [x] Set this ticket to DONE and commit the implementation.

## Acceptance

- No hash appears in any text-consumer input or Estimation transcript.
- An inspected plan with Images is sent without reassembly.
