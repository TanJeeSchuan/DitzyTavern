# Reference Sets and the Image Model in the Paint panel

Status: DONE

Blocked By: 05

Source: `docs/specs/painting.md`, Implementation Decisions 10, 17, 20 and 21.

## Goal

The writer's reference pictures and their labels live in a field of their own that writing a Brief never touches, saved as named Reference Sets per Chat, and the writer switches the Image Model without leaving the panel.

## Work

- [x] Add a References field to the Paint panel. Paint sends the Brief, a `---` line and the References to the Image Model; writing a Brief replaces only the Brief.
- [x] Remove the Appearance References appended after a Brief is written and the Brief References kept across a rewrite.
- [x] Store named Reference Sets per Chat: edits save on their own, New copies the current set under a new name, Rename and Delete; the selected set is remembered per Chat and Fork copies them. A Chat with none shows one empty set.
- [x] Store the References with each Illustration. Use Brief and Edit Brief and repaint load them as a new set named after the Illustration, or select an existing set holding the same References.
- [x] Gallery: pressing a picture inserts it into References at the cursor; the other actions move to a menu; each picture shows where it came from, and an Illustration the model that painted it.
- [x] Picture rows show the Image Model and shape.
- [x] A failed painting whose provider error body is not JSON shows that body, or the HTTP status, instead of a blank row.
- [x] Move Paint Preset and Messages into a collapsed Brief settings section, and the Image Model, Shape and Paint into a footer.
- [x] Tests: the Image Model request carries the Brief, the separator and the References with their Images; Reference Sets survive a reload and a Fork; Use Brief makes a set.
- [x] Verify manually with playwright-cli.
- [x] Update the spec, the glossary and the e2e flows.

## Acceptance

- Writing a Brief again leaves the References as the writer left them.
- The Image Model receives exactly the pictures shown as chips in the Brief and the References.
- Switching the Image Model in the panel changes it in Connection Settings too.
