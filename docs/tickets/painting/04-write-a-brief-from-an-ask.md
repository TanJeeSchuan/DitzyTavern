# Write a Brief from an Ask

Status: IN PROGRESS

Blocked By: 01

Source: `docs/specs/painting.md`, User Stories 15–17, 22, 23, 27–31; Implementation Decisions 6, 7, 9; Testing Decision 4; ADR-0054.

## Goal

A writer types an Ask, or leaves it empty, and the Chat's story model writes the Brief through the Chat's Paint Preset.

## Ownership

- Prompt Preset block references, the preset editor, the built-in presets
- The Chat's preset selections, Fork, and preset deletion
- Generation capture and the Generation Plan seam
- The Paint panel

Overlaps with ticket 02 in Prompt Preset block references. Run it after 02, not beside it.

## Work

- [x] Add the Brief instruction slot: single-use, with authored text and a role, editable in the preset editor. A Generation's Prompt Plan skips it.
- [x] Add the built-in, non-deletable "Default (Paint)" preset holding Lore, history and a Brief instruction, with instruction text that asks for a short description of the scene for an image model.
- [x] Store a Paint Preset selection per Chat beside its story selection, starting on the built-in one. Fork copies it. Deleting a preset reassigns the Chats painting with it to the built-in one.
- [ ] Compile a Brief request through the Generation Plan seam with the Chat's Paint Preset and Generation Settings. History is the last N Messages of the Selected narrative path ending at the Message the panel was opened from. Lore scans those Messages. No Box is captured and no Macro State is written.
- [ ] Send the Ask as the final human message, after everything the preset places. An empty Ask sends a built-in line naming the scene at that Message.
- [ ] Stream the reply into the panel's Brief editor. Store it nowhere.
- [ ] Add to the Paint panel: the Ask box, Write Brief, the Paint Preset picker listing the presets that hold an enabled Brief instruction, and the number of Messages to read, stored per Chat, defaulting to 5, with All.
- [ ] Test through captured requests (Testing Decision 4): the Paint Preset is used, the Brief instruction is included, the request ends with the Ask, exactly the last N Messages are read, matching Lore is included and no Box block is. A Generation on a preset holding a Brief instruction never sends it.
- [ ] e2e: open the panel on an older Message, write a Brief from an Ask, edit it and paint.
- [ ] Verify manually with playwright-cli. No UI tests.
- [ ] Run focused tests locally; let CI run typechecking and the full suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Writing a Brief changes nothing stored in the Chat: no Message, no Macro State, no Box record, no Conversation Revision.
- A Chat whose story preset has no Brief instruction can still write a Brief.
- One preset holding a Brief instruction serves Generations and Briefs, and the story model never receives the instruction.
