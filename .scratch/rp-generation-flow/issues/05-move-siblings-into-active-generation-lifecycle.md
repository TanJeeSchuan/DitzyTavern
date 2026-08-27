# 05 — Move Sibling Generation into the Active Generation lifecycle

**What to build:** Make Swipes use the same server-owned Active Generation lifecycle as Tail Generation. Users should be able to sample several alternatives at one eligible response position while each alternative keeps its own captured prompt, settings, stream, and terminal outcome.

**Blocked by:** 04 — Make Generation subscriptions resumable.

**Status:** complete

- [x] Starting a Sibling Generation immediately creates and selects a server-owned Provisional Variant on the target Message.
- [x] Sibling prompt history contains selected Variants strictly before the target and excludes every target Variant and later Message.
- [x] The target Message's captured historical Control pair governs eligibility and prompt identity while current Generation Settings are captured at start.
- [x] Each parallel sibling has its own Generation identifier, Prompt Plan, safe provenance, event sequence, and terminal state.
- [x] Parallel Sibling Generations are allowed only at the same eligible response position and respect the configured per-Conversation limit.
- [x] Additional sibling attempts above the limit are rejected rather than queued.
- [x] Variant selection remains available while siblings run and does not cancel or reprioritize them.
- [x] New Conversation turns and Control mutations remain blocked until the active response position closes.
- [x] Visible partial Content or Reasoning Content makes an interrupted sibling durable.
- [x] A zero-output sibling failure removes its Provisional Variant and restores the correct prior selected Variant.
- [x] Existing Sibling Generation behavior for unavailable historical Participants and imported Messages remains typed and inspectable.
- [x] The client can observe and distinguish every parallel sibling without provider-specific event handling.

## Comments

Implemented Sibling Generation through the server-owned Active Generation
acceptance, checkpoint, and terminal seams. Each target reserves and selects
its own Provisional Variant, captures the historical pair, reduced Prompt Plan,
settings, safe provenance, and Generation ID, while parallel attempts are
limited to one eligible response position. Empty failures remove only their
provisional Variant and restore the selection that was displaced unless the
user selected another Variant while the attempt ran. Added standalone and
combined SSE transport paths plus plural active-target snapshots so clients
can observe every sibling independently.
