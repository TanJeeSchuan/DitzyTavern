# 09 — Graduate imports into Participant Conversations

**What to build:** Existing SillyTavern imports create native Participant Conversations with immutable authorship and deterministic current Control, including preservation-oriented incomplete Conversations that become playable when the missing seat is filled.

**Blocked by:** 07 — Remove Participants without losing history.

**Status:** resolved

- [x] Every exact resolved source-author group becomes a named Participant, and every imported Message receives a native immutable Author Stamp for its resolved Participant.
- [x] Exact raw source author values, including blank strings, remain unchanged in preserved import data while native blank authors require an explicit nonblank Participant name.
- [x] SillyTavern `is_user`, header roles, a captured Writer name, and other legacy role hints have no effect on Participant identity or Control.
- [x] Current Control is assigned deterministically by first resolved Participant appearance: first human, second model, and all later Participants unseated.
- [x] When one Control assignment already exists, adding the missing Participant preserves it and fills only the empty seat; with neither assignment, the first two Participants fill human then model.
- [x] Imports with zero or one Participant may commit atomically as incomplete Conversations rather than fabricating identities or failing preservation.
- [x] Incomplete imported history remains readable, editable, exportable, configurable, and deletable, while Compose, Generate, and Swipe return the same typed not-playable capability reason.
- [x] Opening an incomplete imported Chat shows its history and a persistent setup surface while withholding play actions; adding the missing Participant derives playability automatically.
- [x] Deterministic current Control does not reinterpret imported history or fabricate historical Control context for imported Messages.
- [x] Existing imported Variants remain selectable and editable but cannot generate new sibling Variants when trustworthy historical context is unavailable.
- [x] Native Messages generated after an imported Conversation becomes playable capture ordinary authorship and historical Control and support the same capabilities as any other native Message.
- [x] The importer composes the public Character Library and Conversation workflows atomically and does not write their domain tables directly.
- [x] Imported Conversations have no imported-only capability mode; after completion they use the same Cast, Control, Participant editing, removal, generation, and Swipe rules as native Conversations.
- [x] Real-SQLite integration tests cover zero, one, two, and many resolved Participants, blank and duplicate names, ignored role hints, deterministic seating, completion, capability gating, imported Swipe denial, and later native generation.
- [x] Focused adapter and UI tests verify incomplete-state presentation and completion; the separate staged browser import flow remains owned by its existing specification.
- [x] Architecture documentation records the narrow incomplete-import exception to the normal requirement that playable Conversations have two distinct occupied Control seats.
