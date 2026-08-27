# 03 — Send through provisional Tail Generation

**What to build:** Make composer Send persist the user's writing as an ordinary Human-authored Message and start a server-owned provisional Tail Generation in one accepted operation. Accepted human writing must remain even when the provider returns no usable output.

**Blocked by:** 01 — Introduce the Generation coordinator seam; 02 — Budget Prompt Plans with tokenx.

**Status:** complete

- [x] Send accepts non-empty composer content together with the expected Conversation Revision.
- [x] Candidate preflight includes the submitted Human-authored Message before anything is persisted.
- [x] Rejected playability, configuration, stale Revision, invalid prompt, or oversized prompt leaves Conversation history unchanged and preserves the client draft.
- [x] Acceptance atomically persists the Human-authored Message, Active Generation, provisional model Message, and Provisional Variant.
- [x] The Human-authored Message uses the Participant holding human Control and records an immutable Author Stamp.
- [x] The provisional model Message captures the Participant holding model Control and the controlled pair at Generation start.
- [x] Provider contact starts only after the accepted provisional target exists authoritatively.
- [x] Normalized provider output resolves the provisional target to complete, interrupted, or length-limited state.
- [x] A zero-output provider failure removes only the provisional model target and retains the accepted Human-authored Message.
- [x] Retrying the unanswered position starts another Generation without duplicating the Human-authored Message.
- [x] The composer clears its draft only after the server accepts Send.
- [x] History and workspace views show the accepted human input and provisional model response position consistently.

## Comments

Implemented revisioned Send acceptance through a server-owned provisional Tail Generation. Candidate prompt budgeting now includes the submitted human writing before persistence; accepted Send atomically writes the human Message, provisional model target, and Active Generation record, then emits acceptance before provider contact. Terminal output resolves the target with outcome/provenance data, while zero-output failures remove only the provisional target so retries reuse the accepted human Message. The client sends its draft and revision and clears the draft only after the acceptance SSE event.
