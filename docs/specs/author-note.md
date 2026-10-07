# Author Note

## Problem Statement

A writer steering a Chat has no Chat-owned place for standing guidance: world facts, tone, format rules, "Messages from Writer are story beats, not events". Prompt Preset instruction blocks are shared across every Chat using the preset and cannot hold Images. Participant Definitions belong to a character, not to this story. A preset block holding `{{getvar::note}}` almost works, but its value is scoped to one preset, changes with the selected branch, and is edited in the Variables panel.

SillyTavern writers already keep this guidance in an Author's Note. Importing such a chat today drops the note, so the imported Chat writes differently from the original.

## Solution

Each Chat has one Author Note: text and Image References the writer controls completely. It has one current value for the whole Chat and enters every later Generation through a single Author Note slot in the Prompt Preset. New Default recipes place the slot directly after history with the system role, and existing presets gain it through an explicit action. The writer edits the note in a primary panel opened from a button next to the composer, with the same chip editor used for Messages. Importing a SillyTavern chat carries its Author's Note over and reports any SillyTavern placement settings it could not keep.

See [ADR-0048](../adr/0048-add-a-chat-wide-author-note-through-a-preset-slot.md).

## User Stories

### Writing the note

1. As a writer, I want one Author Note per Chat, so that I have a single place for standing guidance about this story.
2. As a writer, I want to open the Author Note from a button next to the composer, so that I can adjust it between turns without leaving the story.
3. As a writer, I want the Author Note editor to open as a primary panel, so that it sits with the other authoring tools.
4. As a writer, I want the editor to keep my text exactly as typed, including `*actions*`, quotes and macros, so that the model receives what I wrote.
5. As a writer, I want to paste, drop or pick Images into the Author Note, so that I can show the model a map, outfit or reference sheet.
6. As a writer, I want Images in the Author Note drawn as chips, so that the note looks the same as in my other editors.
7. As a writer, I want to clear the Author Note, so that I can stop steering without deleting anything else.
8. As a writer, I want my Author Note edit saved explicitly and reported if it conflicts with a newer edit, so that I never silently overwrite a change made in another tab.

### What the model receives

9. As a writer, I want the Author Note included in every Generation after I save it, so that my guidance takes effect immediately.
10. As a writer, I want the same Author Note used on every branch, including one I select later from an earlier Message, so that my guidance never silently stops applying.
11. As a writer, I want earlier Generations to keep the Author Note they were sent with, so that Generation Details shows what the model actually saw.
12. As a writer, I want an Active Generation to keep the note it started with when I edit the note mid-stream, so that one reply is never written under two notes.
13. As a writer, I want a blank Author Note to add nothing to the Prompt Plan, so that an empty note costs no tokens.
14. As a writer, I want `{{self}}` in the Author Note to mean my human-controlled Participant and `{{other}}` the model-controlled one, so that notes behave like preset instruction text.
15. As a writer, I want every supported Prompt Macro to work in the Author Note, including `setvar`, so that the note can drive Macro Variables from one place.
16. As a writer, I want Prompt Comments in the Author Note omitted from the Prompt Plan, so that I can annotate my own note.
17. As a writer, I want Images in the Author Note sent to the model at their position, following my Repeated Image Placement setting, so that they behave like Images anywhere else.
18. As a writer using a Text-only Model, I want the Author Note's Images sent as Image Anchors, so that the Generation still runs.
19. As a writer, I want the Author Note never removed to make room for history, lore or memory, so that my steering never silently disappears.
20. As a writer, I want a Generation refused as over budget when the Author Note does not fit, so that I find out instead of getting a Generation without it.
21. As a writer, I want the Author Note not to trigger Lore Entries, Semantic Triggers or Memory extraction, so that lore activation depends only on the story.
22. As a writer, I want the Author Note shown as its own named block in Prompt inspection, so that I can see where it landed and edit it before sending.

### Prompt Presets

23. As a writer, I want new Default recipes to include an Author Note slot directly after history, so that a new Chat's note works without touching presets.
24. As a writer, I want to move the Author Note slot and change its role in the preset editor, so that I decide where the note sits relative to other blocks.
25. As a writer, I want to disable the Author Note slot in a preset, so that one recipe can ignore notes.
26. As a writer with an existing preset, I want an Add Author Note Block action, so that I can opt in without rebuilding my recipe.
27. As a writer, I want to be told when my Chat has a note but its preset has no enabled Author Note slot, with the action that fixes it, so that I don't wonder why the note has no effect.
28. As a writer, I want a preset to hold at most one Author Note slot, so that the note can never be sent twice.
29. As a writer, I want the Author Note slot to show that its text comes from the Chat and is read-only in the preset editor, so that I don't mistake preset text for the note.
30. As a writer, I want native preset export and import to keep the Author Note slot's position, role and enablement, so that sharing a recipe keeps where the note goes.
31. As a writer, I want a native preset import containing more than one Author Note slot rejected, so that a broken file cannot create one.

### Importing SillyTavern chats

32. As a writer importing a SillyTavern chat, I want its Author's Note to become the Chat's Author Note, so that the imported story keeps its standing guidance.
33. As a writer, I want `{{user}}` and `{{char}}` in the imported note mapped to `{{self}}` and `{{other}}`, so that the note means the same Participants it did before.
34. As a writer, I want an import warning when the source note sat somewhere other than after history, so that I know its placement changed.
35. As a writer, I want an import warning when the source note used a role other than system, so that I can change the slot role if it mattered.
36. As a writer, I want an import warning when the source note was inserted less often than every turn, so that I know it now applies to every Generation.
37. As a writer, I want an imported chat with an empty or missing Author's Note to get a blank note and no warnings, so that ordinary imports stay quiet.

## Implementation Decisions

1. **Storage.** The Author Note is a non-null text field on the Conversation, defaulting to empty, outside Generation Settings. Image garbage collection already scans every persisted TEXT column, so the new field needs no extra registration.
2. **Edit command.** One Conversation command sets the note, carrying the expected Conversation revision. Like every other write, it carries Image References as hashes only; the shared prose editor uploads Images itself. It advances the Conversation revision. There is no separate clear command; clearing is saving empty text.
3. **Preset slot.** A new referenced slot kind, `author-note`, joins Lore and Memory: it carries an editable outgoing role defaulting to system, has no stored name or content, and is limited to one occurrence per preset by the database and by the compiler, as Lore and Memory are.
4. **Default recipe.** New Default recipes place the Author Note slot directly after history. Existing stored presets are not migrated; they gain the slot through the Add Author Note Block action, as ADR-0041 does for Lore.
5. **Compilation.** The compiler receives the note text and emits a named Author Note block at the slot's position when the slot is enabled and the expanded text is non-blank. Expansion uses the same Control-pair convention as authored instruction blocks (`self` = human, `other` = model) and the same macro attempt state, so `setvar` writes are recorded with the preset's other writes. Image References are resolved after macro expansion, as everywhere else.
6. **Budget.** The Author Note block is fixed content: it is reserved alongside fixed preset content, before lore, memory and older history, and is never evicted.
7. **Text-only consumers.** The Lore Scan Window, Semantic Trigger judging and Memory extraction keep reading Messages only; none of them receives the note.
8. **Capture.** Active Generations and Generation inspection capture the compiled block like any other. Editing the note never changes a captured plan.
9. **Inactive-note hint.** When the Chat's note is non-blank and its preset has no enabled Author Note slot, the Author Note panel says so and offers Add Author Note Block or enable, mirroring the Lore inactive explanation.
10. **UI.** A primary panel holds the note in the shared CodeMirror prose editor with Image chips. A composer-adjacent button opens it. The preset recipe editor shows the slot like Lore and Memory: read-only source, editable role, enable toggle, movable. Follow DESIGN.md placement rules.
11. **Native preset JSON.** Export and import carry the `author-note` slot. Import rejects more than one occurrence, disabled or not.
12. **SillyTavern chat import.** The decoder reads `chat_metadata.note_prompt`, maps `{{user}}` → `{{self}}` and `{{char}}` → `{{other}}`, and the import projection writes it as the new Chat's Author Note. It adds import warnings for `note_position` other than in-chat (1) or `note_depth` other than 0, `note_role` other than system (0), and `note_interval` other than 1. A missing or empty `note_prompt` yields a blank note and no note warnings. The Canonical Source Archive already keeps the raw header, so the source values stay recoverable.

## Testing Decisions

- Test external behaviour at the highest seam: HTTP contract tests that save a note, then read the compiled Prompt Plan through generation preview or a sent request. Do not test compiler internals separately when the contract test already shows the block's text, role and position.
- Contract tests cover: the block appears after history in a new Default recipe; it is omitted when blank or when the slot is disabled; its role follows the slot; macros expand with the human/model convention and `setvar` writes reach Macro State; a branch selected after the edit still receives the current note; a captured plan keeps the old note after an edit; an oversized note causes the over-budget refusal instead of being dropped; lore keyword matching ignores a keyword that appears only in the note.
- Image support comes from existing machinery (editor upload, plan-wide Reference resolution, the all-TEXT-column orphan sweep). One contract test shows a Reference in the note becomes an image part with its anchor, plus a Text-only Model case sending the anchor only. Prior art: the edited-plan images and generation-plan images tests.
- Preset tests cover the Add Author Note Block action, the single-occurrence rejection, and native export/import round trip. Prior art: the prompt preset library command and authored instruction contract tests, and the lore slot rules.
- Import tests cover note mapping, macro mapping and each warning, using the existing chat import route and staged commit tests as prior art. Add the note fields to the SillyTavern fixture rather than introducing a new fixture.
- One e2e user flow: write a note in the panel, send, and assert the scripted fake received it after history. Prior art: the lore e2e spec. No component or snapshot UI tests.

## Out of Scope

- History-depth placement, for the note or for any preset slot.
- More than one note per Chat, and named notes.
- Branch-carried notes.
- A Character-supplied default note seeded into new Chats.
- SillyTavern insertion frequency.
- Letting the note trigger lore or feed Memory.
- Mapping SillyTavern placement settings onto the preset; they are only reported.
- Exporting the Author Note back to SillyTavern.

## Further Notes

- SillyTavern `note_position` values are `0` after the main prompt, `1` in-chat at `note_depth`, and `2` before the main prompt. Depth only applies to `1`. The sample chat in `.sample-format/chat/` uses position `2`, so its note sat at the start of the prompt and its depth of 4 was ignored.
- `note_role` values are `0` system, `1` user, `2` assistant.
