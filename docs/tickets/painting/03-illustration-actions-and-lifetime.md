# Illustration actions and lifetime

Status: TODO

Blocked By: 01

Source: `docs/specs/painting.md`, User Stories 26, 37–39, 41, 42; Implementation Decisions 12, 14, 15; Testing Decision 6; ADR-0054.

## Goal

A writer can use, refine and remove an Illustration, paint the current scene from the composer, and trust that Illustrations follow their Variant through deletion and Fork.

## Ownership

- The Illustration row and the Paint panel
- The composer
- The story viewport
- The server module for provisional paintings

## Work

- [ ] Open an Illustration full size when pressed.
- [ ] Add "Add to composer": it inserts an Image Reference into the composer, named "Illustration".
- [ ] Add "Edit Brief and repaint": it opens the Paint panel on the Illustration's stored Brief.
- [ ] Add "Delete": it removes the Illustration without changing the Conversation Revision.
- [ ] Add a Paint button to the composer that opens the panel on the final Message. Disable it while the Chat has an Active Generation.
- [ ] Abort a provisional painting when its Variant is removed, using the removed Variants the write observer reports.
- [ ] Make the story viewport follow the bottom when a row is added under the final Message, as it does for a new Message.
- [ ] Test that an Illustration is copied by Fork, dropped by Trim Variants for an unselected Variant, deleted with its Variant, and that its picture and its Brief's references survive the orphan sweep and are swept once it is deleted.
- [ ] Test that deleting a Variant aborts its painting and stores nothing.
- [ ] e2e: paint from the composer, add the picture to the composer and send it; the next Generation's request carries the picture, and the one before it did not.
- [ ] Verify manually with playwright-cli, including a picture arriving under the final Message and one arriving above the viewport. No UI tests.
- [ ] Run focused tests locally; let CI run typechecking and the full suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- An Illustration reaches a story model only after the writer adds it to a Message.
- A picture arriving never moves text the writer is reading or typing.
- Nothing of a deleted Variant's paintings or Illustrations remains after the next sweep.
