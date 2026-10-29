# Fork UI

Status: DONE

Blocked By: 02

Source: `docs/specs/chat-forking.md`, User Stories 1–5, 12, 14–15, 18–19; ADR-0052.

## Goal

A writer forks or rewinds from a Message's actions, or forks from Preview mode, through one dialog, lands in the new Chat, and sees and can remove its Fork link.

## Ownership

- Message actions, Preview mode controls, the Story header
- Fork dialog
- `DESIGN.md` if the dialog or header link adds a pattern

## Work

- [x] Add "Fork from here" to every Message's actions.
- [x] Add "Rewind" to Human-authored Messages' actions. It opens the same dialog, and on success the new Chat's composer holds the returned text and Moves.
- [x] Add "Fork with this Variant" beside Confirm Change and Cancel in Preview mode; it forks with the previewed Variant.
- [x] Build the dialog: name prefilled with "*Name* (fork)", an unchecked "Trim Variants? (Destructive, will remove all other unselected variant data for the fork)" checkbox, Fork and Cancel. Show the refusal reason when a Generation is running.
- [x] Open the new Chat on success and list any Boxes left out because they aren't installed.
- [x] Show "Forked from *Name*" in the Story header, opening the source at the fork point, or at its end when the fork point is gone, with a button that removes the link. On narrow layouts put it in the title menu.
- [x] e2e: fork from a Message with Trim Variants, swipe in the Fork, open the source through the link and see it unchanged; Rewind a Human-authored Message and send its edited text in the new Chat.
- [x] Verify manually with playwright-cli. No UI tests.
- [x] Run focused tests, typechecking, and the full test suite.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Preview mode's Fork leaves the source's Selected narrative path unchanged.
