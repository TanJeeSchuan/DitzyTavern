# 05 — Read graduated history and Import Details

**What to build:** Make a successfully imported Chat fully readable through the same native interaction model as every other Chat. Users can page through resolved Message history, inspect and select preserved Variants, see empty and duplicate alternatives faithfully, and deliberately open Import Details or download the exact source without turning import origin into a visible capability class.

**Blocked by:** 01 — Character System dependency gate; 04 — Resolve Participants and commit the Chat.

**Status:** resolved

- [x] Opening the imported Chat loads native Messages in stable chronological pages rather than returning the full Conversation and all provenance in one response.
- [x] The normal Chat read model includes stable Participant identity, immutable Author Stamp name, Message chronology, Variant order, selected Variant state, and the lightweight fields needed for rendering.
- [x] Exact artifact bytes, canonical archive text, reasoning, signatures, and other heavy provenance are excluded from ordinary paginated reads and loaded only through deliberate detail operations.
- [x] Transcript authorship uses the native Author Stamp created from the resolved Participant name, with no special treatment for source `Writer` or role flags.
- [x] The source-selected Swipe is the initially selected native Variant.
- [x] Normal swipe navigation executes the existing revisioned Variant-selection behavior, persists the selected Variant, preserves later Messages, and never accesses or rewrites either source representation.
- [x] Empty and duplicate Variants remain separate navigable positions; exact empty content uses a presentation-only placeholder without modifying stored text.
- [x] Imported Chats use the same edit, generation, Control, and availability rules as ordinary Chats as those capabilities evolve; no imported-specific read-only state is added.
- [x] Normal Message edits, Variant edits, Participant renames, and later Conversation activity mutate only native domain state and leave canonical and exact source artifacts immutable.
- [x] Chat information conditionally exposes Import Details when provenance exists, without adding a persistent Imported badge, header marker, or separate category.
- [x] Import Details shows the receipt, original filename, SHA-256, declared integrity when present, byte length, counts, warnings, duplicate evidence, and artifact availability.
- [x] Download preserved source streams the exact managed bytes using the stored original leaf filename.
- [x] Missing or corrupt exact artifacts are described as cleaned up or unavailable, disable only exact download, and never prevent normal Chat reading or commands.
- [x] The client keeps pagination, receipt loading, heavy provenance, and artifact download behind typed replaceable boundaries rather than embedding transport behavior throughout Message components.
- [x] Focused server tests cover paginated history, lightweight payloads, stable chronology, Author Stamps, revisioned Variant selection, immutable source data, and nonfatal missing artifacts.
- [x] Focused client-state tests cover page accumulation, selected-Variant updates, empty placeholders, Import Details loading, and missing-artifact presentation without introducing a large frontend test framework.
- [x] One browser smoke test verifies the completed import, graduated Chat reading, swipe selection, Import Details, and exact download in desktop and narrow panel layouts.

## Comments

- Profile Library UI and Participant promotion remain Character System work and are not reintroduced by this ticket.
