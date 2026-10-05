# Image transport and Text-only Models

Status: DONE

Blocked By: 03-prompt-planning-with-images

Source: `docs/specs/image-handling.md`, User Stories 31–34 and 44–48, Implementation Decisions 12 and 13; ADR-0015, ADR-0035, ADR-0046.

## Goal

Translate a plan's Images into AI SDK image parts at their inline positions, and let writers mark Text-only Models.

## Ownership

- `src/server/model-client/chat-completions.ts`
- `src/server/connection-settings/` and `src/client/ProfileModelPicker.tsx`
- The Generation failure view

## Work

- [x] In the Model Client, load bytes and emit the anchor text then an AI SDK image part at each Reference the plan marks as sent.
- [x] Move Images out of `system` and `assistant` messages into a following `user` message, including Human-authored Messages sent as model writing after a seat moves. Refuse an assistant prefill containing an Image before any request. Keep rejecting image, file, modality, audio, and tool Request Overrides.
- [x] Store text-only model IDs per Connection Profile beside the Discovery Catalog, outside the editable settings revision, and send anchors only to marked models.
- [x] When a Generation fails before output with Images in its plan, offer Mark text-only and Mark text-only and retry beside the provider message. Show and toggle the mark in the model picker.
- [x] Test the outgoing request shapes from spec Testing Decision 4 with the captured-request pattern, and that a mark applies across Chats using the Profile. Verify the failure actions and picker manually with playwright-cli.
- [x] Run focused tests, typechecking, and the full test suite.
- [x] Run `/code-review` and resolve its findings.
- [x] Set this ticket to DONE and commit the implementation.

## Acceptance

- Every outgoing image part is in a `user` message, preceded by its anchor.
- No hash appears in any outgoing text.
- The text-only mark is only ever set by the writer.
