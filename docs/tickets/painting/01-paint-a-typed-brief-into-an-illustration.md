# Paint a typed Brief into an Illustration

Status: DONE

Blocked By: None

Source: `docs/specs/painting.md`, User Stories 14, 19, 24, 25, 32–36, 40, 46, 47; Implementation Decisions 4 (Image Model), 5, 10, 11, 13, 14, 16; Testing Decisions 2, 5, 6; ADR-0054.

## Goal

A writer connects an Image Model, opens the Paint panel from a Message, types a Brief, and gets an Illustration in its own row after that Message.

## Ownership

- Connection Settings: API Formats, Connection Presets, the app-wide Image Model selection and its picker
- Model Client: the painting call
- A new server module for provisional paintings and stored Illustrations, and its read
- The Paint panel and the Illustration row in the story view
- The e2e `llm` fake
- `DESIGN.md` if the panel or the row adds a pattern

## Work

- [x] Add the `images` API Format to Connection Profiles, with model discovery, and a Connection Preset for OpenRouter's Image API.
- [x] Add the app-wide Image Model selection, stored under a host namespace, and edit it in Connection Settings with the existing profile-and-model picker.
- [x] Paint through the Model Client with the AI SDK's `generateImage` and the adapter's image model. Send the Brief's text with each Image Reference as its Image Anchor, the referenced Images in order, and the aspect ratio. Store the result through the existing Image ingest; a media type it rejects fails the painting.
- [x] Give the e2e `llm` fake scripted image replies. An unscripted painting fails the test.
- [x] Hold provisional paintings in server memory by Variant. Announce each start, finish and failure through the change feed. One press starts one painting of one picture. A failure keeps the provider's message until the writer retries or dismisses it. A restart drops them all.
- [x] Store a finished painting as one per-Variant data row holding the picture as `image:<hash>`, the Brief text, the Image Model and the shape. Writing it changes no Conversation Revision and reports no touched Variant.
- [x] Add the per-Chat Illustrations read: Illustrations, provisional paintings and failures by Variant, following the change feed.
- [x] Add "Paint" to every Message's actions. It opens the Paint panel with a Brief editor that accepts pictures as Image References, a choice of five shapes stored per Chat, and Paint. Closing the panel does not stop a painting.
- [x] Show a row after a Message for each Illustration of the Variant on screen: a placeholder whose height is reserved from the shape, then the picture, or the failure with Retry and Dismiss. The row is as wide as the text column and at most about half the viewport tall.
- [x] Test the outgoing Image Model request (Testing Decision 5), and that an Illustration lands under a Variant that is no longer selected, without changing the Conversation Revision, and is absent from every Prompt Plan.
- [x] e2e: paint from a Message with a typed Brief and see the picture; swipe that Message away and back; a scripted failure shows the provider's message and Retry paints.
- [x] Verify manually with playwright-cli. No UI tests.
- [x] Run focused tests locally; let CI run typechecking and the full suite.
- [x] Run `/code-review` and resolve its findings.
- [x] Set this ticket to DONE and commit.

## Acceptance

- No hash appears in the text sent to the Image Model.
- An Illustration belongs to the Variant it was painted from and shows only with it.
- Sending, continuing, swiping and editing all work while a picture is being painted.
- A provisional painting appears in no Prompt Plan, no Fork and no stored row.
