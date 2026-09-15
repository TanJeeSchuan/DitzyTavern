# Lorebook design interview

Status: all 36 interview decisions and the consolidated [Lorebook design](lorebooks.md) are accepted. Published as [DT-43](https://plane.tanjs.dev/personal/projects/2a12c18a-22fe-41c6-95fe-37d0a3cbd829/work-items/1a48d224-0529-4226-8588-456d6a92cd13/), in Todo with ready-for-agent. The user also confirmed the existing server Generation/inspection contract boundary and focused compiler, import and Variant-lifecycle tests, with no UI or internal-structure tests. No implementation has started.

The user requested a lorebook design interview, with SillyTavern as a behavioral reference and an embedding keyword matcher under consideration. This document tracks the decision tree. Resolved domain terms belong in [CONTEXT.md](../CONTEXT.md); durable architectural trade-offs belong in [ADRs](adr/).

## Existing constraints

- Lorebook scanning was deferred by [ADR-0001](adr/0001-focused-reimplementation.md) and [ADR-0007](adr/0007-use-typed-prompt-channels.md). This interview considers that deferred feature.
- [ADR-0036](adr/0036-introduce-prompt-presets-as-assembly-recipes.md) introduced shared Prompt Presets and currently excludes World Info placeholders from SillyTavern preset import. Lorebook placement will need an explicit relationship to those recipes.
- [ADR-0035](adr/0035-carry-prompt-context-roles-on-their-entries.md) provides for future dynamically activated context within the ordered Prompt context entries.
- [ADR-0032](adr/0032-compile-generation-plans-through-one-seam.md) keeps Generation planning behind one interface, with the pure Prompt Compiler inside it.
- [ADR-0037](adr/0037-use-sillytavern-syntax-for-prompt-macros.md) requires an inspected plan's expanded text to remain unchanged when used for Generation. [ADR-0038](adr/0038-carry-macro-state-through-selected-variants.md) derives persistent Macro State from selected Variants. Lorebook processing must account for those existing guarantees.
- [DESIGN.md](../DESIGN.md) places primary authoring tools to the left of the Chat, inspection to the right, and uses nested full-screen layers on narrow layouts.

## Accepted decisions

| ID | Decision | Accepted answer |
| --- | --- | --- |
| Q1 | Native authoring, SillyTavern import, or both; selected imported behaviors versus complete behavioral support | Native editor plus import of an explicitly supported subset, reporting unsupported behavior |
| Q2 | Semantic matching against authored trigger phrases, full entry content, or both | Separately authored Semantic Triggers. They are distinct from native Keywords and entry content |
| Q3 | Saved library edits shared across Chats or independent copies per Chat | Shared references with explicit duplication for independent versions |
| Q4 | How Keyword and Semantic Trigger results combine | Per-entry AND or OR between matcher results; list behavior and defaults are settled under Q10 |
| Q5 | Where books can apply | Chat and Character/Participant attachments, with deduplication. Global activation is deferred. Scope belongs to each attachment under Q14; inheritance and deduplication are settled under Q15 |
| Q6 | What text matching scans | A shared Lore Scan Window for both matchers, defaulting to the last four Messages and adjustable. Include both authors and pending human text on the Selected narrative path before the Generation target; exclude Character Definitions, prompt instructions and Reasoning Content |
| Q7 | Recursion, probability, groups, sticky activation, cooldown and delay | Defer these advanced rules |
| Q8 | Embedding execution | Configure a separate embedding endpoint and model, following the proposed OpenAI-compatible connection approach |
| Q9 | Explicitly authored lore versus model-written memory | Explicitly authored lore; automatic memory is deferred |
| Q10 | Populated and empty trigger lists, list-level matching, defaults and unconditional lore | Evaluate populated lists; any match within each list; apply per-entry AND/OR when both are populated, default OR; neither populated means no match; explicit Always bypasses trigger conditions but still obeys budget |
| Q11 | Secondary Keyword conditions on conditional entries | Optional require-any, require-all, exclude-any or exclude-all condition gates the combined result of both matchers. Always entries bypass trigger conditions |
| Q12 | Lexical rules | Default case-insensitive whole-word literal matching, with case-sensitive and substring options; support explicit `/pattern/flags` regex |
| Q13 | Semantic query granularity | Split each Message in the Lore Scan Window into sentences and compare Semantic Triggers against those sentences. The strongest sentence match supplies each trigger's score. The user's approval was conditional on sentence-level splitting, not arbitrary paragraph or overlapping-passage matching |
| Q14 | Attachment-owned scope | Lorebooks remain pure reusable content. Each attachment defines scope: Controlled Participant requires its owner to occupy either control seat; Cast requires its owner to be in the Chat's Cast; Chat is a direct Chat attachment independent of Participants. The same book can have different scopes on different attachments |
| Q15 | Character attachment inheritance and overlap | Copy attachment lists into Participants while keeping book content shared; repeated references to the same book contribute once, while an explicit duplicate remains independent |
| Q16 | Ownership of scan depth | One Chat-owned setting shared by all its books and both matchers; defer book/entry overrides |
| Q17 | Saving and embedding unavailability | Save source text independently. When embeddings are unavailable, evaluate Keywords alone, including for AND entries; skip semantic-only entries, retain secondary Keyword conditions, and indicate fallback. Always entries remain eligible |

The user explicitly conditioned Q2 on trigger phrases being separate from native Keywords. [ADR-0039](adr/0039-introduce-shared-native-lorebooks.md) records scope and shared ownership. [ADR-0040](adr/0040-match-authored-semantic-triggers.md) records the separate semantic target. Resolved terms are in the glossary.

Q6 concerns the matching window, not how much history reaches the writing model. Four counts individual Messages rather than human/model pairs and is an accepted starting default, not a measured optimum. A fresh Send includes the pending human Message. A Sibling Generation ends its scan before the Message receiving the new Variant, excluding that Message's existing text and all later Messages. Both matchers use the chosen source window. Under Q13, only semantic matching divides that text into sentences; lexical matching is not restricted to individual sentences by this decision.

## Round four decisions

| ID | Decision | Accepted answer |
| --- | --- | --- |
| Q18 | Prompt placement | One movable referenced Lore block, initially before history, editable role defaulting to system; defer per-entry history depth and outlets |
| Q19 | Token admission | Chat-owned allowance initially 2,048 estimated tokens; protect response, fixed prompt and protected history first; Always then author priority with stable ties; whole entries, skip oversized and continue; older history uses remaining space |
| Q20 | Macro evaluation | All lore fields remain literal, with no Prompt Macro evaluation |
| Q21 | Semantic threshold | Embedding-configuration default plus optional per-entry override; match tester shows strongest sentence and score; Q33 accepts an editable initial cosine threshold of 0.70, explicitly uncalibrated; no forced minimum match count |
| Q22 | Imports and export | Standalone SillyTavern lorebook JSON and native book JSON import/export; defer PNG extraction; keep supported portions enabled with warnings for unsupported behavior, rather than disabling entries solely for unsupported behavior; exports exclude attachments and scope |
| Q23 | Partial embedding failures and latency | Complete semantic evaluation or keyword-only fallback for the whole Generation; five-second configurable deadline for required embedding work |

The user's Q17 instruction explicitly authorizes this embedding-unavailability fallback despite the repository's general instruction against fallbacks. It does not authorize unrelated compatibility paths. No fallback behavior has been implemented.

## Round five decisions

| ID | Decision | Accepted answer |
| --- | --- | --- |
| Q24 | Duplicate Lore blocks | At most one Lore block per Prompt Preset, an explicit exception to general referenced-slot duplication |
| Q25 | Matching versus history trimming | Match once against captured scan window; do not rescan when budgeting trims history; eligible lore may survive removal of its matching Message |
| Q26 | Preview and fresh-attempt behavior | Preserve the inspected Prompt Plan as the actual model input. User explicitly requested an ADR; ADR-0042 records no silent reassembly and distinguishes the Prompt Plan from its Prompt Preset recipe |
| Q27 | Explanation retention | Keep Lore Activation Records permanently per Variant rather than expiring them after five minutes. Capture the attempt's evidence so later edits to books cannot rewrite the explanation |
| Q28 | Authoring workflow | Popup editor like Prompt Presets, replacing the proposed left Lorebooks panel. Detailed save and toggle behavior will be included in final workflow specification |
| Q29 | Book deletion and independent copies | Show affected attachments before confirmed deletion removes book and attachments; detach preserves book; duplicate/reimport creates independent identities |

An activation explanation answers why a specific attempt included or omitted lore, including matched text, score, secondary conditions, budget and fallback. [ADR-0043](adr/0043-retain-lore-activation-records-with-variants.md) makes these records permanent for retained Variants. A fresh match test uses current inputs and cannot replace the historical evidence. This decision is independent of ADR-0042's exact-inspected-input guarantee and does not automatically commit to retaining full prompts permanently.

## Round six decisions

| ID | Decision | Accepted answer |
| --- | --- | --- |
| Q30 | Matching boundaries | Match a Keyword or regex within one complete Message; combine primary and secondary results across the whole Lore Scan Window |
| Q31 | Manual preview edits and permanent evidence | Retain automatic activation evidence plus the final Lore block text when manually edited; mark edits without inventing per-entry identity for arbitrary replacement text |
| Q32 | Ties and insertion order | Always first, then higher numeric entry priority, then stable book creation/import order, then editable entry order; default priority zero; use the same sequence for admission and prompt text |
| Q33 | Embedding configuration and derived data | One application-wide endpoint/credential/model/threshold/deadline configuration; cache by embedding configuration and source text; model or endpoint changes require corresponding embeddings; cosine similarity with editable, uncalibrated initial threshold 0.70 |

## Final round decisions

Repository inspection confirmed that existing imported presets discarded World Info placeholders, and that permanent Variant data can outlive the five-minute replay cleanup.

| ID | Decision | Accepted answer |
| --- | --- | --- |
| Q34 | Existing presets | New Default recipes include Lore before history; saved presets acquire it through an explicit Add Lore Block action; show why attached lore is inactive when the recipe has no enabled slot |
| Q35 | New preset imports | Map first enabled World Info placeholder in selected source order to Lore; otherwise keep first disabled; omit other positions with warnings; reject native duplicate Lore slots |
| Q36 | Popup save behavior and defaults | Entry-level Save; immediate entry ordering/toggles; separate name/description Save; dirty close/switch offers Save/Discard/Keep editing; new entry enabled and conditional, empty triggers, priority zero |

## Design tree closure

The consolidated design records the accepted behavior and its consequences. There are no further product-choice questions in the current frontier. Implementation must choose ordinary mechanisms that satisfy these rules rather than silently adding capabilities.

| Branch | Resolution |
| --- | --- |
| Authoring and imports | Q1, Q7, Q9, Q20, Q22, Q28-Q29, Q35-Q36 define supported behavior, literal fields, formats, warnings, popup editing and save boundaries |
| Matching | Q2, Q4, Q6, Q10-Q13, Q16-Q17, Q21, Q30, Q33 define scan inputs, conditions, sentence scoring, thresholds and fallback |
| Embedding service | Q8, Q17, Q23, Q33 define separate configuration, derived embeddings, model identity, deadline and whole-Generation fallback |
| Attachment and ownership | Q3, Q5, Q14-Q15, Q29 define shared content, attachment-owned scope, list copying, deduplication and deletion |
| Prompt assembly | Q18-Q20, Q24-Q25, Q32, Q34-Q35 define one slot, literal content, match-once admission, priorities and preset integration |
| Inspection and retention | Q26-Q27, Q31 define exact inspected input, permanent Variant-owned evidence and manual-edit accounting |
| Scope confirmation | User confirmed [the consolidated design](lorebooks.md) and testing boundaries; the spec and decision history are published as DT-43; implementation is a subsequent task |
