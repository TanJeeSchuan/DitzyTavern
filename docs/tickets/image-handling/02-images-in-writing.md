# Images in writing

Status: TODO

Blocked By: 01-image-store-and-portraits

Source: `docs/specs/image-handling.md`, User Stories 18–30, Implementation Decisions 3, 4, 6, 7, and 15; ADR-0046.

## Goal

Let writers place Image References in Messages, Definition Prompt channels, Openings, and Macro Variable values through one CodeMirror 6 editor, and render them in the story.

## Ownership

- A new shared Reference module under `src/shared/` and `src/client/editor/ProseEditor.tsx`
- `src/client/story/` (Composer, StoryMessageView, prose rendering)
- `src/client/characters/DefinitionEditor.tsx` and `src/client/MacroVariablesPanel.tsx`
- Send, edit-variant, Definition, Opening, Macro Variable, and Macro State write paths in `src/server/`
- `DESIGN.md` and `package.json` (CodeMirror 6)

## Work

- [ ] Implement the one parser for `![name](image:<sha256>)`, the formatter with name sanitization, and the `[Image: name]` anchor projection.
- [ ] Build `ProseEditor` on CodeMirror 6, with the stored text as the document. Draw References as `Decoration.replace` thumbnail chips made atomic with `atomicRanges`. Paste, drop, and a file picker insert at the cursor, and the bytes stay pending for the owning command.
- [ ] Use it in the Composer, Variant edit, Definition Prompt channels and Openings, and Macro Variables panel. Add Insert Portrait to the Definition editor. Do not offer Images in Prompt Preset or Lore Entry editors.
- [ ] Carry inline Image bytes in Send, Variant edit, Definition create and update, and Macro Variable apply. Re-sync references on every write of those owners, including Macro State written by `setvar` during a Generation.
- [ ] Render `image:` References in prose as inline thumbnails that open a Radix Dialog, and render missing Images as muted anchors. Stop rendering every other image URL.
- [ ] Amend DESIGN.md for chips, thumbnails, the Dialog, and missing anchors.
- [ ] Test the parser, sanitization, and anchor projection, plus the reference lifetime cases: edits, deletes, a pasted token needing no bytes, and an Image held only by a non-selected branch's Macro State. Verify the editors and rendering manually with playwright-cli. No UI tests.
- [ ] Run focused tests, typechecking, and the full test suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- Text saved from `ProseEditor` is byte-identical to what was typed.
- An Image exists only after the command that first references it commits.
- No remote image URL is fetched when prose renders.
