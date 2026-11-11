# Appearance and Describe

Status: IN PROGRESS

Blocked By: None

Source: `docs/specs/painting.md`, User Stories 1–13; Implementation Decisions 1, 2, 3, 4 (describing model), 19; Testing Decisions 3, 7; ADR-0054.

## Goal

Every Definition has an Appearance of description text and pictures, the story model receives it, and a model can describe a picture into it on request.

## Ownership

- The Prompt channels of Character and Participant Definitions, and the Definition editor
- Prompt Preset block references and the built-in Default preset
- Connection Settings: the app-wide describing model selection and its picker
- The image viewer
- Seed and teardown data

Overlaps with ticket 01 in Connection Settings and with ticket 04 in Prompt Preset block references. Run it after 01, not beside it.

## Work

- [x] Add the Appearance channel to every Definition, edited like the other channels. It copies with the Definition on seeding, Save as Character and duplication.
- [x] Add the "Send Appearance Images" switch to the Definition, on by default, copied with it. When off, a Prompt Plan reads that Definition's Appearance References as Image Anchors.
- [x] Add the `human-appearance` and `model-appearance` preset references, each starting with the role of the matching Identity block, to the preset editor's add-block menu. An empty Appearance renders nothing.
- [x] Migrate the built-in Default preset to hold both, each right after its Identity block.
- [x] Add the app-wide describing model selection, stored under a host namespace, and edit it in Connection Settings with the existing picker.
- [x] Add the Describe route: Image hashes and an optional Ask in, text out, through the existing Model Client, with the built-in instruction from Implementation Decision 3.
- [x] In the image viewer opened from a picture in Appearance, add Describe with an Ask box. It inserts the text right after that picture's Reference.
- [x] Add a Describe button to the Appearance field with an Ask box. It sends every Appearance picture, or the Portrait when there are none, and appends the text. Neither button replaces existing text.
- [x] Give seed data an Appearance and update the teardown to match.
- [x] Test through captured requests: the built-in preset sends Appearance after Identity, an empty one sends nothing, the switch off sends anchors without Images, and a Describe request carries the chosen pictures or the Portrait, and the Ask.
- [x] Verify the editor, the switch and both Describe buttons manually with playwright-cli, in the Character editor and a Participant editor. No UI tests.
- [x] Run focused tests locally; let CI run typechecking and the full suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No existing Chat's Prompt Plan changes until an Appearance is filled in, except that a `{{pick}}` in a slot after the new blocks of the built-in story preset may choose again once.
- The Portrait reaches a model through Appearance only when the writer inserts it or presses Describe with no Appearance pictures.
- Changing a Character's Appearance or switch never changes a Participant it seeded.
