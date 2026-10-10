# Author Note becomes the first Box

Status: TODO

Blocked By: None

Source: `docs/box-system/spec.md`, User Stories 1–4; Implementation Decisions "Contract", "Prompt Preset", "Generation lifecycle" step 3, "Author Note Box"; ADR-0048, ADR-0050.

## Goal

The Author Note behaves exactly as it does today, but it reaches the Prompt Plan as a Box through a `box:author-note` preset block. This proves the Box registry, the generic slot and pinned admission.

## Ownership

- Box contract types and registry
- Prompt Preset block references and their unique index
- Generation plan admission of Box items
- Author Note storage

## Work

- [ ] Define the Box contract and a compiled-in registry. Ship only the hooks this ticket uses (`setup`, `advance`), and leave the remaining ones to the tickets that consume them.
- [ ] Replace the `author-note` preset reference with `box:<id>` references, guarded by one partial unique index per `(preset, reference)` for `box:` references. Migrate existing blocks and drop the `author-note` index.
- [ ] New Default recipes include every registered Box block. The existing Add Author Note Block action becomes the generic add-Box-block action.
- [ ] Move the note from the Conversation column into `conversation_data` under `box:author-note`, and drop the column. Dev data may be cleared.
- [ ] Capture each enabled Box's setup and run `advance`. Admit its items in the Box's block through the Prompt Macro pass. Pinned items count toward the total, and overflow raises `PromptBudgetExceededError`.
- [ ] The Author Note `advance` returns one pinned item, or nothing when the note is blank. Lore scanning, Semantic Triggers and Memory extraction still ignore it.
- [ ] SillyTavern chat import still maps the Author's Note.
- [ ] Update the existing Author Note tests and e2e to the new storage. No tests that assert the contract's shape.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The Author Note's Prompt Plan, panel, inactive explanation, preset export/import and import mapping are unchanged from the writer's view.
- An oversized note makes the plan inadmissible, as before.
