# SillyTavern lorebooks and semantic matching

Source inspection for the [DitzyTavern lorebook design interview](../lorebooks-design.md). Implementation references are pinned to SillyTavern release commit `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`; documentation references are pinned to `70e5e4d3c239253fca4692fe82e3936cb9c4b1b1`. Findings describe inspected source, not a running comparison test.

## Semantic matching

SillyTavern embeds each eligible entry's full `content`. It does not embed its title or keywords. The Vector Storage extension gathers applicable books, skips disabled and empty entries, and indexes entries marked `vectorized` or included by its global enable-all setting. Content hashes identify the indexed text. See [vector activation and indexing](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/extensions/vectors/index.js#L1623-L1687).

The query joins recent nonempty chat messages, newest first. It strips attached file text and substitutes macros. Vector Storage has its own query-message setting, independent of lexical scan depth and extra character/persona sources. See [query construction](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/extensions/vectors/index.js#L901-L923) and the [matching documentation](https://github.com/SillyTavern/SillyTavern-Docs/blob/70e5e4d3c239253fca4692fe82e3936cb9c4b1b1/Usage/worldinfo.md#L276-L296).

The server applies a similarity threshold and an overall maximum result count across the queried collections. It returns hashes and metadata rather than scores. Vector Storage maps those hashes to entries and emits `WORLDINFO_FORCE_ACTIVATE`. See [server query](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/src/endpoints/vectors.js#L407-L437) and [hit activation](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/extensions/vectors/index.js#L1698-L1725).

That forced activation skips both primary and secondary keyword checks. Disabled state, generation-type restrictions, character filters, timing and recursion restrictions run earlier. Probability, inclusion groups and budgeting run later. An entry can still activate lexically while vectorized; removing its keys makes it semantic-only. See the [scanner's branch order](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L4684-L4875) and [later admission checks](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L4881-L4957).

Consequences relevant to DitzyTavern's design:

- A secondary `NOT ANY dream` condition does not veto a semantic hit. It belongs to the skipped keyword checks.
- Retrieved entries can fail later filters. The query does not fetch replacements to fill the gaps.
- Similarity does not decide final prompt placement; the scores do not reach the scanner.
- Hash-based hit mapping can activate multiple entries with identical content, including an entry not itself marked vectorized. This follows from mapping matching hashes over all applicable entries.
- Editing a paragraph changes the entry's semantic target. DitzyTavern has instead chosen separately authored Semantic Triggers in [ADR-0040](../adr/0040-match-authored-semantic-triggers.md).

## Other behavior worth deciding explicitly

| Area | Inspected SillyTavern behavior |
| --- | --- |
| Primary keys | Any matching primary key is sufficient to reach secondary checks |
| Secondary keys | `AND ANY`, `AND ALL`, `NOT ANY`, and `NOT ALL` |
| Lexical options | Case sensitivity and substring or whole-word matching; a valid slash-delimited JavaScript regex uses its own flags |
| Whole words | Single-word keys use a boundary regex; multiword keys still use substring matching |
| Recursion | Admitted entry content enters the lexical scan buffer; vector retrieval does not rerun recursively |
| Scope | Shared books referenced globally or through character, persona and chat settings; duplicate book references are suppressed |
| Ordering | Chat lore first, then persona lore, then character/global lore according to the selected strategy; entry order also participates |
| Budget | Whole-entry admission; ordinary processing can stop at an entry that reaches or exceeds the budget; `ignoreBudget` has special handling |
| Placement | Before/after character information, examples, Author's Note, a chat depth, or a named outlet |
| Timing | Sticky retains activation, cooldown suppresses activation, and delay requires a minimum chat length; settings count individual messages |
| Card import | A converter maps embedded character books, including many SillyTavern extension fields |

Sources: [lexical matcher](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L337-L365), [secondary checks](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L4793-L4868), [loading and ordering](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L4363-L4527), [scanner](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L4881-L5250), [timing documentation](https://github.com/SillyTavern/SillyTavern-Docs/blob/70e5e4d3c239253fca4692fe82e3936cb9c4b1b1/Usage/worldinfo.md#L299-L318), [card converter](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L5498-L5554).

Two source/documentation differences should not become accidental DitzyTavern requirements. The docs say [depth zero still scans recursive content and Author's Note](https://github.com/SillyTavern/SillyTavern-Docs/blob/70e5e4d3c239253fca4692fe82e3936cb9c4b1b1/Usage/worldinfo.md#L345), but the [buffer returns before appending those sources](https://github.com/SillyTavern/SillyTavern/blob/8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8/public/scripts/world-info.js#L279-L325). The docs also promise [constant entries first](https://github.com/SillyTavern/SillyTavern-Docs/blob/70e5e4d3c239253fca4692fe82e3936cb9c4b1b1/Usage/worldinfo.md#L376), while the inspected core order uses scope and insertion order, then sticky priority, without a constant-first rule.

## DitzyTavern integration facts

The local source inspected at commit `4621758` has no lorebook model, matcher, attachment storage or embedding client. The existing compilers are pure and synchronous, so embedding I/O needs an explicit boundary outside them. See [Prompt Compiler contract](../../src/server/prompt-compiler/types.ts#L21) and [Generation Plan Compiler](../../src/server/generation-plan/compiler.ts#L1).

Budgeting binary-searches how many oldest whole history entries to omit, relying on each omission shortening the prompt. Recomputing lore activation on each shortened candidate could violate that assumption. See [budgeting](../../src/server/prompt-compiler/budget.ts#L122). Lore selection, token allocation and truncation order need a deliberate design.

Matching input must follow the attempt's selected history. Send includes pending human text; Sibling Generation excludes its target and later Messages. See [Send capture](../../src/server/workflows/generate-capture.ts#L659) and [selected history](../../src/server/conversation/selected-history.ts#L100).

Preview acceptance compares captured preparation, preserves expanded content and validates edited plans without recompilation. Lorebook edits and embedding configuration will need to participate in that contract. See [preview acceptance](../../src/server/workflows/generation-preview.ts#L213). Completed inspection data currently expires after [five minutes](../../src/server/conversation/generation-retention.ts#L6), so permanent activation explanations would require a retention decision.

Prompt Preset import currently [omits World Info placeholders with diagnostics](../../src/server/prompt-preset/sillytavern.ts#L44). There is no existing character-card decoder supplying embedded `character_book` data. Chat import archives its source but does not turn it into active lore.

## Follow-up facts for preset integration and retained explanations

Default's original recipe comes from [migration SQL](../../src/server/database/migrations/0000_special_venom.sql#L329), but users can edit the stored recipe. New custom presets start empty and duplicates copy their source slots. The library keeps converted recipes, not the SillyTavern source needed to reconstruct discarded World Info positions. See [preset import and creation](../../src/server/prompt-preset/library.ts#L140). An existing preset therefore needs an explicit placement policy when Lore is introduced.

The current add and duplicate operations do not impose per-reference uniqueness. At-most-one Lore requires validation of all entry paths, including imports and disabled occurrences. See [block operations](../../src/server/prompt-preset/blocks.ts#L181). Source import removes both `worldInfoBefore` and `worldInfoAfter` in its [classification](../../src/server/prompt-preset/sillytavern.ts#L313) and [conversion loops](../../src/server/prompt-preset/sillytavern.ts#L394); future imports need an explicit rule to select one native location.

[Variant-owned data](../../src/server/database/schema.ts#L394) persists independently of generation replay cleanup. It cascades deletion with the owning Variant and can retain self-contained evidence after source book or earlier Message edits. Terminal and Stop paths share [Variant-data persistence](../../src/server/conversation/commands/active-generation.ts#L179). A retained Lore record needs lifecycle coverage, a server-owned namespace protected from generic data commands, and a detail read projection. This is a suitable existing storage mechanism, not evidence that Lore retention is implemented.

Preview acceptance keeps the original capture while replacing its plan with the validated edited plan. Consequently, automatic activation evidence and manually edited Lore text describe different stages. Permanent explanations should retain that distinction once the complete prompt inspection expires. See [preview acceptance](../../src/server/workflows/generation-preview.ts#L260).
