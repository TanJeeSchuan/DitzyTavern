# Author Note becomes the first Box

Status: DONE

Blocked By: None

Source: `docs/box-system/README.md` "The contract", "Preset block", "Generation lifecycle" step 3, "Built-in Boxes" (Author Note); ADR-0048, ADR-0050.

## Goal

The Author Note behaves exactly as it does today, but it reaches the Prompt Plan as a Box through a `box:author-note` preset block. This proves the Box registry, the generic slot and pinned admission.

## Ownership

- Box contract types and registry
- Prompt Preset block references and their unique index
- Generation plan admission of Box items
- Author Note storage

## Work

- [x] Define the Box contract and a compiled-in registry. Ship only the hooks this ticket uses (`setup`, `advance`), and leave the remaining ones to the tickets that consume them.
- [x] Replace the `author-note` preset reference with `box:<id>` references, guarded by one partial unique index per `(preset, reference)` for `box:` references. Migrate existing blocks and drop the `author-note` index.
- [x] New Default recipes include every registered Box block. The existing Add Author Note Block action becomes the generic add-Box-block action.
- [x] Move the note from the Conversation column into `conversation_data` under `box:author-note`, and drop the column. Dev data may be cleared.
- [x] Capture each enabled Box's setup and run `advance`. Admit its items in the Box's block through the Prompt Macro pass. Pinned items count toward the total, and overflow raises `PromptBudgetExceededError`.
- [x] The Author Note `advance` returns one pinned item, or nothing when the note is blank. Lore scanning, Semantic Triggers and Memory extraction still ignore it.
- [x] SillyTavern chat import still maps the Author's Note.
- [x] Update the existing Author Note tests and e2e to the new storage. No tests that assert the contract's shape.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- The Author Note's Prompt Plan, panel, inactive explanation, preset export/import and import mapping are unchanged from the writer's view.
- An oversized note makes the plan inadmissible, as before.
