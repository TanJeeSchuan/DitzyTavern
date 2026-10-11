# Rewrite the authoring guide for the generic host

Status: DONE

Blocked By: 15-thoughts, 17-generic-digests

Source: the guide test report (11 gaps); tickets 16 and 17, including ticket 17's note that a digesting Box still had to build its own passage list and override editor.

## Goal

`docs/box-system/authoring.md` describes the generic host as built: adding a Box is its descriptor, one server module, one client module and tests. Every gap from the guide test report is resolved.

## Ownership

- `docs/box-system/authoring.md`
- `docs/box-system/spec.md` where it differs from the code

## Work

- [x] Extract the World Clock window's passage timeline (per-passage record, Writer override editor, reset, catch-up progress) into a host component any digesting Box gets from its descriptor. Override fields are built from the Box's record schema. The World Clock window keeps only its setup form and uses the shared timeline.
- [x] Rewrite "Add a Box" for the generic host, with a check per step that can run without a live app.
- [x] Give every hook a "Host wiring" line, or state that it needs none.
- [x] Cover the lens contract, the `read`, `dependencies` and `remove` hooks, digests and per-Box Decision Model selection, window CSS, and that parsers used by both lens and `read` live in `src/shared/`.
- [x] Resolve each of the 11 gaps from the guide test report, or explain why it no longer applies.
- [x] Have the reviewer check every claim against the code.
- [x] Set this ticket to DONE and commit.

## Acceptance

- The guide names no step that edits a host file.
- A digesting Box gets its passage timeline and override editor without writing them.

## Notes

- The passage timeline is `src/client/box-windows/PassageTimeline.tsx`. The window layer renders it after the Panel of every Box with a `decision` descriptor, and gives such a Box a dock tab showing `status`, so its `boxWindows` entry omits `DockTab`, may omit `Panel`, and may add `describe(record)` for the summary. The generic read route serves the timeline read for digesting Boxes, so they declare no `read`.
- Behavior change: the World Clock's Writer override now takes exact minutes in a number input built from the record schema, instead of elapsed bins. The bins moved into the server module, since only the digest uses them.
- `status` is called only by the timeline read, so it is typed digest-only, and the Race's unconsumed `status` hook was removed.
- The e2e fixture `enableWorldClock` became `selectBoxDecisionModel(request, box)`, so a new digesting Box's spec needs no fixture edit.
- The 11 guide-test gaps:
  1. Step 2 claimed `typecheck` passes: fixed. Step 3 registers the descriptor, server module and server lookup together before its typecheck, and says why the build fails until all three exist.
  2. Hand-maintained test lists: no longer applies. Ticket 16 derives the `BoxStates` fixtures and Default preset block lists from `boxIds` and `boxDescriptors`.
  3. `installDefaultPresetBoxes` not explained: fixed in "Preset block".
  4. A step-4 check needed a live app: fixed. Every step's check is `check:contracts`, `typecheck`, `check` or `test:e2e`.
  5. Missing "Host wiring" lines: fixed. Every hook has one, and each says none, because ticket 16 and 17 made the host find hooks through the registries.
  6. Wrong `StoryStage` path: no longer applies. Ticket 16 made lenses generic, so the guide names no host lens file.
  7. No lens contract shape: fixed in "Lens".
  8. No CSS guidance: fixed in "Window CSS".
  9. Route ordering: no longer applies. Ticket 16 replaced the per-Box routes with one generic read route, and a Box adds no routes.
  10. Schema placement: fixed in step 2, which also names `check:contracts` as the rule's enforcement.
  11. Under-specified capture inputs: fixed. Ticket 16 added the `dependencies(read)` hook, and the guide tables `CaptureRead`.
- Dock status now folds every selected record, as Generation capture does; before, a passage whose prose was cleared dropped out of the status but not the prompt.
- The override editor rejects `Type.Optional` record fields. A field that may be unset is a union of literals with null.
- Review: `gpt-6.1-sol` high via `delegate_task`, checking every guide claim against the code, over two rounds. Round 1 found six should-fix items (the editor ignored the window lock, optional fields, the fingerprint claim, the dock status fold, the Race override claim, `status` and `read` overstated as required), all fixed. Round 2 confirmed them and found three wording fixes, applied. Nothing blocking remained.
