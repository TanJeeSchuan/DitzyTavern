# 05 — Generate historical Swipe Variants

**What to build:** A user can generate another Variant for an older native model Message using the Participants under whose Control that Message was created, without changing the Conversation's current Control assignments.

**Blocked by:** 03 — Generate replies from Participant Definitions; 04 — Manage Cast and Control from the Chat.

**Status:** resolved

Implemented in lane `pi-parallel-1cf2ece7-ef7d-4fd3-b137-80b3daee969f-0` (commits `0a69959`, `c02832f`).

- [x] Every native generated Message and configured opening Message stores immutable historical human and model Participant identities captured at creation or generation start.
- [x] Targeted Swipe eligibility is derived from the target Message's historical context rather than whether its author currently occupies model Control.
- [x] A new sibling Variant uses the historical pair's current Definitions and names, current generation settings, and the selected history preceding the target Message.
- [x] `{{self}}` and `{{other}}` resolve against the target Message's historical pair during sibling generation.
- [x] The target Message's existing sibling Variants are excluded from its preceding prompt history.
- [x] Generating a sibling Variant does not change current human or model Control and does not change the Message's Author Stamp.
- [x] An opening Message can generate an additional Variant after its configured openings while preserving their native order and shared authorship.
- [x] Renaming the historical model Participant changes its current Definition contribution for a later sibling generation, while the Message continues displaying its captured author name.
- [x] If trustworthy historical context is absent or a required historical Participant no longer has a usable Definition, existing Variants remain available and new sibling generation is denied with a typed reason.
- [x] The Conversation snapshot exposes Swipe eligibility and the reason for ineligibility for each relevant Message.
- [ ] UI behavior at the final Variant invokes historical Swipe generation and presents unavailable reasons without reassigning the composer selectors.

## Note

The UI TODO above is deferred deliberately: in this lane the client story surface is still the pre-server mock workspace and no message/swipe surface consumes server Conversation Messages yet (the current Generate workflow also has no transport route yet). The per-Message swipe eligibility (with typed reasons) is already exposed on the wire via the Conversation snapshot and the typed client (`client/conversation.ts`), so the transport/UI phase can wire the final-Variant gesture without further server work.
- [x] Real-SQLite public-interface tests cover Control changes before Swipe, current Definition changes, macro resolution, opening generation, history selection, sibling exclusion, missing context, and unchanged current Control.
- [x] The existing Variant-generation architecture decision is amended to replace the current-model-Control gate with Message-captured historical Control semantics.
