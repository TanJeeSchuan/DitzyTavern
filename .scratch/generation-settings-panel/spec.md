# Generation Settings panel

Status: ready-for-agent

## Problem Statement

Conversation Generation Settings own thirteen editable fields, but the interface exposes only four of them. Model selection lives beside the composer, and Continuation owns its own primary panel; sampling parameters (temperature, Top P, frequency penalty, presence penalty), budget fields (context limit, response budget, Safety allowance, Sibling Generation limit), and Conversation-owned Request Overrides are validated, persisted, snapshotted into Variant provenance, and round-tripped through every save, yet no surface exists to edit them.

ADR 0019 promises each Conversation's model selection, sampling parameters, context limit, response budget, and extra request body fields remain "independently tunable". ADR 0023 gives Generation Settings their own whole-object Apply action. The current partial exposure satisfies neither promise.

## Solution

Consolidate all Chat-scoped generation configuration behind one "Generation" primary panel that absorbs the existing Continuation panel rather than adding a parallel writer against the same revisioned aggregate. The panel follows the established draft-plus-Apply pattern: local draft edits stay client-local, one Apply sends a whole-object revision-guarded command, conflicts preserve the complete local draft alongside refreshed authoritative state.

Rollout is sliced so each pass lands reviewable:

1. **Slice 1** — consolidation plus Sampling fields.
2. **Slice 2** — Budget fields (context limit, response budget, Safety allowance, Sibling Generation limit).
3. **Slice 3** — Request Overrides editor covering all three API Format namespaces.

## Decisions

Recorded during grilling (2026-08-27):

- End state: every field of Conversation Generation Settings becomes user-editable, including Safety allowance and Sibling Generation limit even though ADR 0019's ownership sentence does not enumerate them.
- The consolidated panel replaces the rail entry currently labeled Continuation. This relabels a shipping surface and must be recorded, not silent (DESIGN.md handoff notes).
- Model selection stays beside the composer where it exists today. The panel shows the current model ID read-only rather than duplicating the combobox or moving it into settings-only reach.
- Request Overrides show all three API Format namespaces; namespaces not matching the active Connection Profile stay editable and are never transmitted (ADR 0019 wording).
- Because Request Override keys win last on the wire ([deepseek.ts](../../src/server/model-client/deepseek.ts) merge), the overrides editor flags keys colliding with first-class Sampling fields instead of leaving the precedence implicit.

## User Stories

1. As a user, I want one Generation panel that holds every Chat-owned generation control, so that I configure a Chat in one place.
2. As a power user, I want to set temperature, Top P, frequency penalty, and presence penalty per Conversation, so that each Chat writes at the sampling I choose without provider defaults imposed on me.
3. As a user, I want an empty sampling field to mean the provider default, so that I opt into sampling only when I care about it.
4. As a user editing Continuation inside the same panel, I want my continuation strategy, prefill suffix, and instruction preserved exactly as before, so that consolidation changes nothing about how my Chat continues after a length limit.
5. As a user whose Generation Settings changed elsewhere, I want Apply to fail safely with my draft intact, so that concurrent edits never corrupt configuration.
6. As a user, I want invalid numeric input rejected before reaching the server boundary semantics, with messages matching what the server would say, so that feedback feels like one system.

## Notes

- Design reference: DESIGN.md audience ("power users value detailed control") and visual principle 3 (advanced controls appear through explicit disclosure, not permanent cockpit).
- Visible copy avoids em dashes, decorative numbering, and playful substitutes per DESIGN.md anti-patterns.
- Unexposed budget and override values must survive every Apply unchanged until their slices ship; the server command already validates and backfills, so no migration is needed.
- Out of scope for this feature: provider-side defaults discovery, per-participant sampling (Participants and Characters own no sampling configuration), group-chat orchestration.
