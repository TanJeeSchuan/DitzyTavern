# Cast Appearance, references and gallery

Status: DONE

Blocked By: 02, 03, 04

Source: `docs/specs/painting.md`, User Stories 18, 20, 21, 43–45; Implementation Decisions 2, 8, 10, 17; Testing Decisions 3, 4; ADR-0054.

## Goal

The Brief writer reads how every Cast member in the scene looks, the painting gets their pictures as references, and the writer can reuse any picture in the Chat.

## Ownership

- Prompt Preset block references and the built-in "Default (Paint)" preset
- The Brief request
- The Paint panel
- A new per-Chat gallery read

## Work

- [x] Add the Cast Appearance block: a single-use preset reference that a Generation's Prompt Plan skips. In a Brief request it renders the Appearance of every Cast member who authored one of the Messages being read or whose name appears in them or in the Ask, seated or not, each under its name.
- [x] Migrate "Default (Paint)" to hold the block before Lore.
- [x] Read a Definition's Appearance References as Image Anchors in a Brief request when its switch is off.
- [x] After a model writes a Brief, append every Appearance Reference of each Cast member whose name appears in it and whose switch is on, with no cap. The writer can remove any of them.
- [x] Add the gallery read: without duplicates, the Chat's Illustrations from every Variant, the Image References in every Variant of its Messages, and the Cast's Portraits and Appearance References.
- [x] Show the gallery as a strip in the Paint panel. Each picture has "Add to composer" and "Use as reference", which insert an Image Reference into the composer or the Brief.
- [x] Name an Illustration added to the composer with the first words of the Ask it was painted from, or "Illustration" when there was none. Store the Ask with the Illustration.
- [x] Test through captured requests: a Brief request carries the Appearance of an unseated Cast member named in the Messages read, sends anchors without Images for a Definition whose switch is off, and a Generation on a preset holding the block never sends it.
- [x] Test that the gallery read returns one entry for a picture used several times and includes an Illustration under an unselected Variant.
- [x] e2e: write a Brief naming a third Cast member, see their Appearance pictures added as references, remove one, add a gallery picture as a reference, and paint; the Image Model request carries exactly those Images.
- [x] Verify manually with playwright-cli. No UI tests.
- [x] Run focused tests locally; let CI run typechecking and the full suite.
- [x] Run `/code-review` and resolve its findings.
- [x] Set this ticket to DONE and commit.

## Acceptance

- A Cast member holding neither Control seat is described to the Brief writer when they are in the scene.
- The Image Model receives exactly the reference pictures shown as chips when Paint is pressed.
- The gallery shows pictures from swipes the writer has moved away from.
