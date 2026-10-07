# Author Note in the Prompt Plan

Status: TODO

Blocked By: None

Source: `docs/specs/author-note.md`, User Stories 1–25, 28–29; Implementation Decisions 1–8, 10; ADR-0046, ADR-0048.

## Goal

A writer opens the Author Note panel from the composer, writes text and Images, saves, and the next Generation's Prompt Plan contains an Author Note block directly after history in a new Default recipe.

## Ownership

- Conversation storage, snapshot read and the set-Author-Note command
- Prompt Preset contract, schema check and Default recipe (new `author-note` slot)
- Prompt compiler and Generation Plan compilation, budgeting and capture
- Author Note primary panel and composer button; recipe editor row for the slot
- `DESIGN.md` if the panel adds a new pattern

## Work

- [ ] Add the Author Note text field to the Conversation, default empty, and return it in the Conversation read.
- [ ] Add the revisioned set-Author-Note command. Saving empty text clears the note.
- [ ] Add the `author-note` slot kind with default role system, one occurrence per preset in the schema and compiler, and place it after history in new Default recipes.
- [ ] Compile the slot into a named Author Note block: expand macros with the authored-instruction Control-pair convention and the shared macro attempt state, omit it when disabled or blank after expansion, reserve it as fixed content.
- [ ] Keep the note out of the Lore Scan Window, Semantic Trigger judging and Memory extraction.
- [ ] Show the slot in the recipe editor like Lore and Memory: read-only source, editable role, toggle, movable.
- [ ] Build the primary panel with the shared prose editor and the composer button that opens it.
- [ ] Contract tests: block after history; omitted when blank or disabled; slot role honoured; `{{self}}`/`{{other}}` convention; `setvar` reaches Macro State; branch selected after the edit gets the current note; captured plan keeps the old note; oversized note refuses as over budget; a keyword only in the note activates no Lore Entry; an Image Reference in the note becomes an image part with its anchor, and a Text-only Model receives the anchor only.
- [ ] e2e: write a note in the panel, send, assert the fake received it after history.
- [ ] Verify the panel manually with playwright-cli. No UI tests.
- [ ] Run focused tests, typechecking, and the full test suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- Editing the note never changes an already captured Prompt Plan.
- The same note reaches Generations on every branch.
- A blank note adds no block and no tokens.
