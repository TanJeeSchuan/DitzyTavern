# Generation with Images

Status: TODO

Blocked By: 02-images-in-writing

Source: `docs/specs/image-handling.md`, User Stories 31–48, Implementation Decisions 8–14; ADR-0015, ADR-0035, ADR-0046.

## Goal

Send Images to models: resolve References in Prompt Plans, estimate and place them, translate them into AI SDK image parts, and let writers mark Text-only Models.

## Ownership

- `src/server/prompt-compiler/`, `src/server/generation-plan/`, and Active Generation persistence
- Text-consumer inputs in `src/server/lorebook/` and `src/server/memory/`
- `src/server/conversation/generation-settings.ts` and its client editor
- `src/server/model-client/chat-completions.ts`
- `src/server/connection-settings/` and `src/client/ProfileModelPicker.tsx`
- `src/client/PromptPlanPreviewPanel.tsx`, `src/client/GenerationDetailsPanel.tsx`, and the Generation failure view

## Work

- [ ] Resolve References after Prompt Macro expansion across the Prompt Plan. Plans, checkpoints, and Active Generation records hold References only, and Active Generation records are registered in the reference index.
- [ ] Route the Lore Scan Window, Semantic Trigger judging, Memory extraction, embeddings, and the Estimation transcript through the anchor projection.
- [ ] Add each sent Image's `w·h/750` cost, after notionally fitting its long edge to 1568 px, to its entry, keeping whole-entry eviction. Add the Repeated Image Placement Generation Setting (first, last, every; default last), applied after eviction, with its trade-offs explained in the UI.
- [ ] Show Images in Prompt inspection with `ProseEditor`, allow editing an inspected plan with Images, and warn about missing Images in inspection and Generation Details.
- [ ] In the Model Client, load bytes and emit the anchor text then an AI SDK image part at each sent Reference. Move Images out of `system` and `assistant` messages into a following `user` message. Refuse an assistant prefill containing an Image before any request. Keep rejecting image, file, modality, audio, and tool Request Overrides.
- [ ] Store text-only model IDs per Connection Profile beside the Discovery Catalog, and send anchors only to marked models. When a Generation fails before output with Images in its plan, offer Mark text-only and Mark text-only and retry beside the provider message. Show and toggle the mark in the model picker.
- [ ] Test spec Testing Decisions 4–6 with the captured-request pattern and the budget interface. Verify inspection, the setting, and the Text-only Model flow manually with playwright-cli.
- [ ] Run focused tests, typechecking, and the full test suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- Every outgoing image part is in a `user` message, preceded by its anchor.
- No hash appears in any outgoing text, text-consumer input, or Estimation transcript.
- An inspected plan with Images is sent without reassembly.
- The text-only mark is only ever set by the writer.
