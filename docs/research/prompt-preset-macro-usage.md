# Macro usage in sample prompt presets

Inspected `.sample-format/prompts/Freaky Frankenstein 5 - Internal States - Fast.json` and `.sample-format/prompts/Marinara's Spaghetti Recipe(1).json` on 2026-09-10. This is static inspection of prompt text and ordering, not a runtime compatibility test. Both have a `100001` prompt order; Marinara also has a `100000` order. Findings about enabled blocks below use `100001`, matching ADR-0036's import rule.

The design interview is complete. [ADR-0037](../adr/0037-use-sillytavern-syntax-for-prompt-macros.md) records the engine and assembly decisions; [ADR-0038](../adr/0038-carry-macro-state-through-selected-variants.md) records variable state, storage, and editing. These decisions supersede the original research's handwritten-parser recommendation and single shared variable-store proposal. Application code has not been changed by this interview.

## Marinara uses variables to assemble a prompt

Enabled toggle blocks assign `prompt`, `tense`, `narration`, `perspective`, `length`, and `guidelines`. Later enabled blocks read them. For example, the Past toggle contains `{{setvar::tense::past tense}}`, Third-Person contains `{{setvar::narration::third-person}}`, and Output Format reads both with `getvar`.

These writes are essential to the preset's composition. Their observed use does not require surviving into another Generation: the enabled toggles supply the values again during assembly. Removing variable assignment support would break ordinary preset toggles. Sharing a variable environment across ordered blocks would support this pattern; resetting it for each block would not.

The preset also uses Prompt Comments and `trim`. Role toggle values contain legacy `<BOT>` and `<USER>` placeholders, so the macro catalogue alone does not settle import coverage. The enabled Summary block reads `{{summary}}`, which requires a separate source of summary content.

## Frankenstein mixes composition with intended lasting state

The enabled Main Prompt clears 16 template and instruction variables. Later enabled modules assign text fragments and the Internal States and BOLT blocks read them. This is another direct need for cross-block variable assignment and nested arguments. Some fragments contain HTML, which prompt expansion must preserve as text.

The enabled Chekhov's Gun block contains seven `{{roll::1d20}}` expressions. The enabled BOLT block contains two more. Fresh expansion on each swipe would therefore reroll these inputs. The user clarified that dice rolls should be fresh for each Variant generation, so reusing the fully expanded prompt unchanged would violate that intent.

World Sim demonstrates `{{setvar::worldsimRoll::{{roll::1d20}}}}` followed by reads of `worldsimRoll`, but is disabled in the supplied order. The Debug Engine contains `addvar` and `incvar` examples but is absent from that order. Their presence in the file is not evidence that they run in the supplied configuration.

The enabled GM's Notebook and Relationships blocks also read values intended to persist across turns, including `gmNotebook`, bonds, sparks, and grudges. Some instructions ask the model to retain state in its generated HTML, while others claim macro-backed persistence. Those are different mechanisms. A prompt's prose saying that state persists does not establish how the application updates it.

There is a concrete authoring problem in GM's Notebook. An outer `setvar::gmNotebookCoT` contains an unescaped `{{setvar::gmNotebook::[Your updated list of entries here]}}` as an example of what the model should write. Under the eager nested-argument semantics documented in [the engine research](sillytavern-macros.md), the inner assignment executes while assembling the prompt instead of remaining an instruction for later. This is an inference from the syntax and researched semantics, not an executed result. The samples are usage evidence, not a normative language specification.

## Per-attempt assembly and fresh Variant randomness

The user clarified that macros such as dice rolls should be random for each Variant generation, then approved assembly from current inputs for each Generation attempt. Siblings do not share frozen recipe or definition inputs. Already captured prompts stay fixed, and edits affect subsequent attempts. The user also approved Conversation-persistent `setvar`/`getvar` and preserving an inspected prompt's exact macro results when generating from it.

The accepted evaluation boundary gives each Generation attempt fresh dice and stable expansion results across its budget calculations and send. If a variable contains a dice result, dependent reads must use that attempt's value. Replacing numeric substrings in a previously expanded prompt cannot reproduce nested assignments or conditional branches. This is a design decision, not an implemented change.

This retains [ADR-0009](../adr/0009-allow-parallel-sibling-variant-generation.md), which lets each sibling compile from current definitions and settings. [ADR-0021](../adr/0021-support-editable-one-shot-prompt-inspection.md) also describes prompt edits as applying to one Generation. The current sibling capture path recompiles in `src/server/workflows/generate-capture.ts`; completed Variants do not retain a permanent reusable Prompt Plan. No durable shared sibling prompt is required by the accepted direction.

Captured clock values and random results remain fixed through inspection, budget calculations, and sending. Previewing does not persist writes. A change to relevant captured inputs requires refreshing the preview; elapsed time or unrelated sibling completion alone does not. `pick` remains stable for the same Conversation, preset, source text, and macro position.

The accepted syntax, Chevrotain evaluator split, internal registration, persistent variables, per-attempt assembly, and exact preview reuse decisions are recorded in [ADR-0037](../adr/0037-use-sillytavern-syntax-for-prompt-macros.md).

## Accepted initial scope and deferrals

The user approved nested arguments, conditionals and scoped content, comments and text utilities, Conversation-variable operations, dice/random/pick, time/date, and existing participant macros for the first catalogue. Supported spellings, aliases, and syntax follow the pinned source research, with intentional runtime and persistence differences defined in the ADRs.

| Group | Initial support |
| --- | --- |
| Existing participants | `self`, `other`, with the existing import translation of `user`/`char` |
| Text and comments | `space`, `newline`, `noop`, `trim`, `reverse`, `//` and its `comment` alias; retain scoped Prompt Comments |
| Control flow | `if`, `else`, nested arguments and scopes, implemented whitespace preservation through `#` |
| Preset-scoped Conversation variables | `setvar`, `getvar`, `addvar`, `incvar`, `decvar`, `hasvar`, `deletevar`, their local aliases, and local shorthand operators |
| Randomness | `roll`, `random`, `pick` |
| Time/date | `time`, `date`, `weekday`, `isotime`, `isodate`, `datetimeformat`, `timeDiff` |

Deferred groups:

- Global variables and their named operations and shorthand. Conversation variables are in scope.
- World Info and lorebook integration, including `outlet`.
- Summary, Author's Note, and related extension-provided prompt content. Marinara's `summary` expression will remain unsupported.
- Instruct and Text Completion template macros, prompt separators and prefixes, and the `banned` side effect.
- Additional chat, swipe, group, persona, and character-card accessors beyond the existing participant macros, such as `lastMessage`, `currentSwipeId`, `group`, `greeting`, and creator notes. These are deferred by catalogue scope, not a claim that every underlying value is unavailable in DitzyTavern.
- Additional runtime metadata such as `model`, `lastGenerationType`, `original`, reasoning prefixes, extension detection, and the `maxPrompt`/`maxContext`/`maxResponse` families. The approved time/date group does not imply chat-dependent `idleDuration` support.
- UI-dependent values such as `input`, `firstDisplayedMessageId`, and `isMobile`.
- Public extension registration and plugin loading. Internal code-level registration is in scope.

The researched SillyTavern flags `!`, `?`, `~`, and `>` and named arguments have no implemented upstream semantics at the pinned commit, so they are not a promised backlog. Model-produced macro execution is excluded: the user plans a separate memory tool call. Regex scripts and other non-macro integrations are not supplied by this engine.

## Accepted variable-state behavior

Acceptance-time mutation of one shared variable store was not approved. Siblings must start from the variable state before their target Message. A `turn` increment from 5 therefore produces 6 for every sibling rather than advancing to 7 or 8 as more alternatives are requested. The next Message generation can advance from 6 to 7.

Variants can still produce different resulting values, for example by storing their independently sampled dice results. The user approved carrying forward only selected Variants' recorded writes, in Message order, with the latest assignment or deletion determining each variable. Unselected Variants cannot affect future generation by finishing or recording their results. Changing an older selection leaves later text and writes unchanged; a later selected assignment still overrides the earlier value. Retained interrupted or failed Variants retain their writes under the ordinary Variant lifecycle. Manual writes attach to the selected Variant at the inspected position, or to preset-scoped initial values before the first Message. These rules are recorded in [ADR-0038](../adr/0038-carry-macro-state-through-selected-variants.md).

For Q9, the user rejected model-produced macro execution and plans a memory tool call instead. No generated state-update section or output-macro interpreter belongs in this implementation.

## Accepted preset isolation and variable UI

The user raised frequent Prompt Preset switching as a state-ownership problem and approved namespacing by Conversation and Prompt Preset. A shared scope would let a preset that reads `length` without assigning it inherit Marinara's prior value. Preset isolation intentionally refines the earlier Conversation-wide lifetime and differs from SillyTavern's shared local-variable behavior.

The accepted rule is to derive variables from selected Variants' writes belonging to the active Prompt Preset. Switching to another preset changes the namespace used for assembly without deleting either preset's writes. Switching back derives that preset's state from the current Selected narrative path, never from its unselected alternatives. This preserves per-preset continuity and isolates accidental naming collisions, but deliberately prevents cross-preset variable sharing. It also makes counters such as `turn` preset-specific unless supplied by a separate explicit Conversation-context value.

Rename and ordinary edits keep the namespace, while duplication creates a separate namespace. A never-used preset starts with empty variables. The user requires variables to be visible and editable in the UI and approved attaching manual writes to the selected Variant at the inspected position, with preset-scoped initial values before the first Message. Participant-owned fields share the active preset's scope during assembly, and opening writes attach to the greeting Variant under the creation-time preset. The planned memory tool remains a separate domain; macro namespace decisions do not specify its storage or behavior.

Current code has stable numeric preset IDs: Conversation selection is stored in `conversation_prompt_preset`, and recipe resolution reads the current selected row in `src/server/prompt-preset/recipe.ts`. Rename retains the identity, duplication creates a new identity, and deletion switches referencing Conversations to Default in `src/server/prompt-preset/library.ts`. Generation capture currently keeps recipe slots rather than preset identity, so preset-scoped writes would require capturing the originating preset ID with the attempt; they must not be attributed to whichever preset is selected when the attempt finishes.

Storage inspection found that both `conversation_data` and `message_variant_data` already exist in `src/server/database/schema.ts`. Their namespace/key uniqueness and owner-cascade lifecycles are exposed by `src/server/conversation/commands/put-data.ts`. The Variant table can retain per-preset write records without inventing a new lifetime or branch store. The chosen implementation direction is to reuse it under macro-owned validation and state-derivation code. Conversation data alone cannot replace those records because it would collapse sibling-specific values into a single mutable map.

There is no existing variables UI. The Variables panel will show the active preset, effective names and values, and the Message/Variant contributing each value, with add, edit, and delete actions. It follows DESIGN.MD's secondary inspection tools in the right panel on wide layouts and nested full-screen layers on narrow layouts. Manual edits affect state after the inspected selected Variant; changing a sibling's input requires editing before its target Message.

## Assembly boundaries verified in current code

`budgetPromptPlan` varies only the supplied history context; it does not omit authored recipe or opening blocks. Its repeated compiler calls receive the same definitions, slots, and intent. History is copied literally, so expanding enabled authored blocks once before budget search can preserve both text and writes across all candidates. The earlier concern about a budget-discarded authored block executing writes does not apply to the current omission rules.

The compiler processes enabled slots in order and skips disabled slots. Each enabled occurrence is processed separately, including duplicates. Macro expansion currently applies to Participant Definition fields and preset-authored instruction content. A Conversation's opening is separately expanded once during creation and saved as greeting Variant content; later generations do not expand it again. The user approved retaining opening writes on that greeting Variant under the preset selected at creation, without transferring or rerunning those writes after preset switches.

Continuation instructions currently enter the plan intent as raw text and are not passed through `expandText`. Human-authored history and edited Message text also remain literal. Sources: `src/server/prompt-compiler/budget.ts`, `src/server/prompt-compiler/compiler.ts`, `src/server/generation-plan/compiler.ts`, and `src/server/conversation/create.ts`.

Q16 is approved: inspected prompt text is a direct edit of the generation input. Its manual edits do not trigger a macro pass or alter the writes already recorded during expansion. Q17 is approved: existing macro-enabled Participant fields use the active preset's variable namespace, and opening writes use the preset selected at Conversation creation.

## Clock, stable selection, and preview validity

- Q18 is approved: capture one instant and the initiating client's timezone and locale; explicit macro timezone arguments take precedence. There is no existing Conversation timezone or locale setting or corresponding compilation metadata. Server timestamps currently use ISO UTC, so the new engine needs explicit formatting context instead of deriving it from existing display-only formatting.
- Q19 is approved: `random` and `roll` sample afresh per attempt; `pick` stays deterministic for the same Conversation, preset, source text, and position. Source or choice changes may change its result. The source research documents chat, content, and position seeding; DitzyTavern additionally scopes it to preset identity.
- Q20 is approved: require refreshing when relevant captured assembly inputs change, including selected history, preset, definitions, effective settings, and variable input. Unrelated sibling completion and the mere passage of time do not invalidate an otherwise unchanged captured preview. Manual inspection edits are preserved as literal final input and do not alter expansion-time variable writes.
