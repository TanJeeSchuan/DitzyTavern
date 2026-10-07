# Add a Chat-wide Author Note through a preset slot

Each Chat owns one Author Note: writer-authored text that can contain Image References, sent with every later Generation. The writer controls it completely. It has one current value for the whole Chat and does not follow the Selected narrative path, so an edit reaches every branch, including one selected later from an earlier Message. Earlier Generations keep the note text their Prompt Plans captured. Writers who want a value that differs per branch already have `{{getvar}}` and Macro State under [ADR-0038](0038-carry-macro-state-through-selected-variants.md).

The note reaches the Prompt Plan only through a single Author Note Referenced Prompt Block in the Prompt Preset. As with the Lore block in [ADR-0041](0041-assemble-lore-through-a-budgeted-preset-block.md), a preset may contain at most one Author Note block. Its position and role belong to the preset. New Default recipes place it directly after history with the system role. Existing presets gain it through an explicit Add Author Note Block action. When a Chat's note is non-blank but its preset has no enabled Author Note block, the UI explains that the note is inactive and offers the add or enable action. A blank note contributes no block. History-depth injection stays deferred as in [ADR-0036](0036-introduce-prompt-presets-as-assembly-recipes.md), even though SillyTavern places its Author's Note at a chat depth.

The note is stored in its own Conversation field and edited by its own command, not inside Generation Settings. Generation Settings describe how the model is called. The note is writing content.

Note text goes through the macro engine and follows the preset convention: `{{self}}` resolves to the human-controlled Participant and `{{other}}` to the model-controlled Participant. Variable writes in the note, such as `setvar`, are allowed and recorded like any other preset text's writes. That means a Chat-wide note can produce writes that differ per branch. Image References follow [ADR-0046](0046-admit-images-natively.md). Preset text cannot author References, so the note can carry Images only because the Chat owns it.

The note is fixed content for budgeting. Its space is reserved before lore, Memory and older history, and it is never removed to make room; an over-budget plan is refused as it is today. The Lore Scan Window, Semantic Trigger judging and Memory extraction do not read the note, because a note that triggered lore would be a hidden way to force entries in.

Importing a SillyTavern chat maps `chat_metadata.note_prompt` to the Author Note, with `{{user}}` mapped to `{{self}}` and `{{char}}` to `{{other}}`. `note_depth`, `note_position`, `note_role` and `note_interval` are dropped. Each value other than system role, placement after history, or every-turn interval produces an import warning.

## Considered Options

- Branch-carried notes, recorded on Variants as Macro State is: rejected because a writer's edit would silently fail to reach a branch selected afterwards.
- Leaving writers to use a preset instruction block holding `{{getvar::note}}`: rejected because that value is scoped to one preset and follows the selected branch, and the Variables panel is a poor place to write a steering note.
- An Author Note channel in Participant Definitions: rejected because it would mostly duplicate Post-History Instruction.
- A Character-supplied default note seeded into new Chats: deferred until writers find themselves retyping notes.
- History-depth placement, either for the note alone or as a general preset feature: deferred. A slot placed directly after history covers the case where the note should be the last thing the model reads, without a second placement mechanism.
- SillyTavern's insertion frequency: rejected because clearing the note does the same job.
