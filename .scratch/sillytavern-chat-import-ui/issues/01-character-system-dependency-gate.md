# 01 — Character System dependency gate

**What to build:** Establish that DitzyTavern's separately owned Character System exposes the native identity capabilities required by the Chat import UI. This is a dependency-verification gate, not authorization to implement Participants, Actor Profiles, the Profile Library, Roster behavior, or Author Stamps inside the import effort.

**Blocked by:** None — this gate resolves only when the external Character System implementation exists.

**Status:** resolved

- [x] The Conversation public seam can atomically create a Conversation with stable Conversation-local Participants, initial Roster membership, Messages, Variants, and immutable inline Author Stamps.
- [x] An Author Stamp records the stable Participant identifier and the Participant name captured when the Message is created.
- [x] Renaming a Participant affects future Author Stamps without rewriting existing Message stamps.
- [x] The Profile Library public seam can list and read Actor Profiles for name-only resolver suggestions.
- [x] Adding from an existing Actor Profile creates a new independent Participant and full Participant Prompt fork without a live synchronization or identity link.
- [x] The Character System can create a new Actor Profile while resolving a new Participant without requiring the import module to write Profile tables directly.
- [x] Actor Profile names are not treated as unique identity keys.
- [x] Chat-only Participants are valid Roster members and do not require an Actor Profile.
- [x] The public seams can participate in the import's required all-or-nothing SQLite operation without moving domain invariants into HTTP routes or the import adapter.
- [x] Completion evidence and the owning Character System implementation references are recorded under Comments before this gate is marked resolved.

## Comments

- Created as a non-implementation dependency gate. All implementation tickets in this effort remain blocked until these capabilities exist.
- Resolved 2026-08-24. The Character System is implemented through the deep Conversation and Character Library seams in `src/server/conversation/` and `src/server/character-library/`, with cross-domain composition in `src/server/workflows/`.
- Evidence: `ConversationModule.create` atomically persists Participants, Control/Roster state, Messages, Variants, and inline Author Stamps; Character Library `list`, `get`, and `execute` provide profile discovery and creation; Character-to-Cast and native-chat workflows create independent full Definition forks; ad-hoc Participants and duplicate Character names are supported.
- Verification: 87 focused Character/Conversation/workflow tests passed; the full suite passed with 263 tests; `bunx tsc --noEmit`, `bun run lint`, and `bun run build` also passed.
