# Lorebooks

Status: accepted by the user and published as [DT-43](https://plane.tanjs.dev/personal/projects/2a12c18a-22fe-41c6-95fe-37d0a3cbd829/work-items/1a48d224-0529-4226-8588-456d6a92cd13/) with the ready-for-agent label. All 36 individual decisions are recorded in the [interview log](lorebooks-design.md). The [published spec's local copy](specs/lorebooks.md) includes user stories, implementation decisions and testing decisions. The feature is not implemented.

## Ownership and scope

A Lorebook is shared library content containing ordered Lore Entries. Saved edits affect subsequent Generations in every Chat using the book. Duplication and native reimport create independent identities. Book exports contain no attachments or scopes.

Scope belongs to each attachment, so one book can have different uses without copying its content.

| Attachment scope | Eligibility |
| --- | --- |
| Controlled Participant | The attached Participant occupies either control seat for the Generation |
| Cast | The attached Participant belongs to the Chat's Cast, including unseated Participants |
| Chat | The book is attached directly to the Chat, independently of Participants |

Creating a Participant copies its Character's attachment list, including the scopes of those uses. Later Character attachment edits do not rewrite the Participant's list. Referenced book content stays shared.

Evaluate applicable attachments before deduplicating by book identity. Any applicable attachment makes its book eligible; an inapplicable attachment does not veto another applicable one. Repeated references contribute each entry once. Explicitly duplicated books remain independent even when their text is identical.

Removing an attachment preserves the book. Deleting a book first shows the affected attachments; confirmation removes the book and those attachments. Historical Lore Activation Records remain with their Variants.

## Entry matching

Each entry contains literal lore content, Keywords, separately authored Semantic Triggers and activation controls. No lore field evaluates Prompt Macros, including entry content. Macro-looking text remains literal.

The shared Lore Scan Window is Chat-owned and defaults to four individual Messages. It includes both authors and pending human text for Send. It follows the Selected narrative path before the Generation target, so a Swipe cannot scan its existing answer or later Messages. Character Definitions, preset instructions and Reasoning Content are excluded. This window determines matching, not how much history the writing model receives.

Keywords default to case-insensitive whole-word matching, with case-sensitive and substring options. Explicit `/pattern/flags` regex keywords are supported. A Keyword or regex must match inside one complete Message. Primary and secondary results combine across the scan window; text from different Messages cannot manufacture a single phrase match.

Semantic matching sends the scanned Messages to Typesafe Jev as the scene and asks one yes/no question per distinct enabled Semantic Trigger: whether its situation happens or is discussed in the scene. Jev's probability is the trigger's score. A long scene or many triggers are split across bounded requests sent one after another, and a trigger keeps its highest score.

| Entry configuration | Primary result |
| --- | --- |
| Keywords only | Any Keyword matches |
| Semantic Triggers only | Any trigger meets the threshold |
| Both lists, OR | Either matcher succeeds |
| Both lists, AND | Both matchers succeed |
| Neither list populated | No match |
| Always | Trigger conditions are bypassed |

Only populated lists participate. OR is the default operator. Conditional entries may additionally require any or all secondary Keywords, or exclude activation when any or all secondary Keywords match. This secondary condition constrains the combined primary result, including semantic matches. Always bypasses secondary conditions too; it does not bypass enablement, attachment eligibility or budgeting.

An empty secondary list supplies no additional condition. Disabled entries contribute no content. Entry titles are editing metadata rather than matching targets or automatically injected text.

## Jev and fallback

Semantic Triggers are configured once under Connections, in the Typesafe Jev section shared with Memory: the Jev model, the write-only credential, a Jev or Off mode, and one probability threshold that starts at 0.5. There is no per-entry threshold and no minimum quota forcing weak semantic matches into the prompt. Authored text saves independently of Jev availability.

Each Jev request has a fifteen-second deadline. Use a complete semantic evaluation or keyword-only fallback for the whole Generation, including when Semantic Triggers are off or the credential is missing. Do not mix partial semantic results with per-entry fallback.

In fallback, evaluate Keywords alone even for AND entries. Skip semantic-only entries, retain secondary Keyword conditions, and keep Always entries eligible. Indicate fallback in inspection and the retained record. Missing, failed or unusable Jev results must not masquerade as semantic non-matches.

The match tester operates on the saved entries in the open Lorebook and the writing supplied to it. It is an independent entry-level check: it does not require Chat attachments, attachment eligibility, Chat history or an enabled Lore block in the Prompt Preset. It shows the strongest Semantic Trigger, its Jev probability and the threshold, along with lexical and secondary-condition results, and does not rewrite historical records.

## Prompt placement and budget

Each Prompt Preset permits at most one referenced Lore block, including disabled occurrences. It is movable and has an editable role defaulting to system. Entry content remains literal when inserted. Only admitted entry content enters the block; titles, scores and diagnostic labels stay in inspection.

Match once against the captured scan window, then budget the resulting candidates without rescanning shortened history. A selected entry may survive even if the Message that triggered it is later trimmed.

Each Chat has a Lore Allowance initially set to 2,048 estimated tokens. It is a ceiling rather than a guaranteed reservation. Preserve the existing context-limit and safety-allowance rules. Reserve response budget, fixed preset content and protected history before admitting lore. If those protected inputs cannot fit, use the existing explicit budget failure rather than silently removing them.

Admission and final Lore text use this order:

1. Always entries before conditional entries.
2. Higher numeric entry priority first, default zero.
3. Stable book creation/import order.
4. Editable entry order within each book.

Admit whole entries within both the Lore Allowance and available prompt space. Skip an entry that does not fit and continue to smaller ones. The estimate must account for assembled content and its separators, rather than allowing formatting to escape the budget. Older history then uses remaining space. Always entries may be omitted for budget.

When no Lore block is enabled, no lore matching or Jev work contributes to Generation. The independent match tester remains available for saved entries in the open Lorebook. If books are attached, explain why lore is inactive and offer the appropriate add or enable action.

New Default recipes include Lore immediately before history. Existing saved recipes acquire it explicitly through Add Lore Block; do not silently change their authored order. Blank custom presets remain authored recipes to which the user can add the slot.

## Inspection and permanent evidence

The inspected Prompt Plan, including accepted manual edits, is the writing context sent to the API. Starting Generation from inspection must not rematch lore, expand macros again, replace keyword fallback after endpoint recovery, or silently trim the inspected text. Provider encoding preserves the captured content, roles and Generation intent. Invalid, stale or oversized plans may be rejected; they must not be repaired into different text and sent.

Explicit Refresh assembles again. Changes to captured lore inputs invalidate a preview; endpoint recovery alone does not. Fresh Generations and Swipes use current saved books and attachments with the attempt's existing history and control rules. Already captured Generations remain fixed.

Keep a Lore Activation Record for as long as its Variant is retained, with no five-minute expiry. Each sibling has its own evidence. Record the relevant book/entry identity and source values, attachment eligibility, matching text and scores, conditions, priority and budget outcomes, and fallback status. Capture the evidence needed to explain the attempt rather than depending on mutable books or a later rerun of matching.

Later edits to books, story text or selected Variants do not rewrite an existing record. Source book deletion does not delete it. Deleting its owning Variant removes it; retained interrupted output follows the same Variant lifecycle. An attempt removed for producing no retained output has no lasting Variant-owned record.

If the user manually edits the inspected Lore block, keep both the automatic activation explanation and the final edited Lore text, marked as manually edited. Do not infer entry identities from arbitrary replacement text. Permanent lore evidence does not require permanently retaining the entire Prompt Plan or provider request.

## Authoring and imports

Edit books in a popup like Prompt Presets. Support search, create, duplicate, import/export, and entry editing. Each entry has its own Save action; entry order and enable/disable toggles persist immediately. Book name and description have a separate Save action. Closing or switching with dirty text offers Save, Discard and Keep editing.

A new entry starts enabled and conditional, with empty triggers, OR and priority zero. It cannot activate until configured. Attachments are managed where the book is used, with their scope independent of the editor's shared book content. Follow the existing responsive popup and inspection conventions in DESIGN.md.

Support standalone SillyTavern lorebook JSON import and native Lorebook JSON import/export. Preserve supported fields and behavior. Warn about unsupported behavior while leaving supported portions usable, rather than disabling an entry solely because its source used an unsupported feature. Preserve an explicit source-disabled state. Do not invent Semantic Triggers from entry content or Keywords, turn an unmatchable imported entry into Always, or evaluate imported macro syntax.

Unsupported recursion, timing, probability, groups, full-content vector matching, placement and macro behavior need actionable diagnostics. A semantic-only source entry whose full-content matching is unsupported may have no usable native triggers until edited, despite remaining enabled. The native format includes authored book and entry data, not credentials, attachment scopes or historical activation records.

For new SillyTavern Prompt Preset imports, keep the location of the first enabled World Info placeholder in the selected source order as the single Lore block. If all such placeholders are disabled, keep the first disabled. Warn that other World Info positions were collapsed. Native imports containing duplicate Lore blocks fail validation.

## Concrete outcomes to verify

| Scenario | Required outcome |
| --- | --- |
| One Message ends with `Silver`; the next starts with `Keep` | Keyword `Silver Keep` does not match |
| A primary match is in one Message and excluded `dream` is in another scanned Message | The secondary condition blocks the entry |
| An AND entry has a Keyword match but Jev is unavailable | Whole-Generation fallback allows the Keyword result, still subject to secondary conditions |
| The same outage affects a semantic-only entry | It is skipped; it does not become Always |
| A book is attached directly to Chat and to an unseated Controlled Participant | Chat attachment makes it eligible, once |
| An entry matches text that budgeting removes | Its lore remains eligible without rematching |
| An Always entry exceeds the remaining allowance | Skip it and consider later smaller entries |
| An inspected fallback prompt is sent after endpoint recovery | Send the inspected text unchanged |
| The inspected Lore block was manually replaced | Keep automatic evidence and actual edited text distinctly |
| A source book is edited or deleted a month later | The old Variant's activation explanation remains available |
| Existing preset has attached books but no Lore block | Explain inactivity and offer explicit addition |
| Imported preset has two enabled World Info positions | Keep the first in selected source order and warn about collapse |

## Implementation boundaries and deferrals

Resolve Jev I/O outside the existing pure compiler and capture its results with the Generation's inputs. Keep one Generation planning path for normal sends, Swipes, continuation and inspection. Use Variant-owned durable data for permanent evidence rather than extending the five-minute replay timer. Server-owned evidence must not be editable through generic data commands. These are integration consequences of the existing architecture, not separate user-facing workflows.

Schema layout and numeric validation must implement the accepted behavior without adding new product modes. The 0.5 threshold requires tuning for the user's chosen Jev model and writing; this design makes no measured retrieval-quality claim. Appropriate implementation verification covers matching, budgets, imports and Generation/Variant lifecycle. The repository forbids UI tests.

Defer global book activation, recursive matching, probability, inclusion groups, sticky/cooldown/delay rules, full-content semantic matching, per-entry scan depths, per-entry history placement, named outlets and PNG book extraction. Lore fields do not evaluate macros. Complete SillyTavern compatibility is outside scope.

## Decision references

- [ADR-0039: shared native Lorebooks](adr/0039-introduce-shared-native-lorebooks.md)
- [ADR-0040: separately authored Semantic Triggers](adr/0040-match-authored-semantic-triggers.md); its matching mechanism is superseded by ADR-0044
- [ADR-0044: judge Semantic Triggers with Jev](adr/0044-judge-semantic-triggers-with-jev.md)
- [ADR-0041: one budgeted Lore block](adr/0041-assemble-lore-through-a-budgeted-preset-block.md)
- [ADR-0042: send the inspected Prompt Plan](adr/0042-send-the-inspected-prompt-plan-without-reassembly.md)
- [ADR-0043: permanent Lore Activation Records](adr/0043-retain-lore-activation-records-with-variants.md)
- [Pinned SillyTavern source research](research/sillytavern-lorebooks.md)
- [Domain glossary](../GLOSSARY.md)
