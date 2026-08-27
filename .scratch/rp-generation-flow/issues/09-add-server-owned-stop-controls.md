# 09 — Add server-owned Stop and Stop All

**What to build:** Replace browser-request abortion with explicit server-owned cancellation. Users should be able to stop one selected Generation or all parallel siblings while preserving useful partial writing and applying the same cleanup rules across every client.

**Blocked by:** 05 — Move Sibling Generation into the Active Generation lifecycle; 06 — Checkpoint and recover Active Generations.

**Status:** complete

- [x] Stop targets one identified Active Generation and Stop All targets every Active Generation at the response position.
- [x] Cancellation is an explicit server command and does not depend on which client started or currently observes Generation.
- [x] Cancelling one parallel sibling does not cancel another sibling.
- [x] Cancelling a Generation with Content or Reasoning Content forces a final checkpoint and persists an interrupted Variant.
- [x] Cancelling a zero-output Tail or Continuation Generation removes its provisional model Message while retaining accepted human input.
- [x] Cancelling a zero-output sibling removes its Provisional Variant and restores the correct prior selection.
- [x] Cancellation does not persist a provider error message unless a distinct non-cancellation failure also occurred.
- [x] Stop and provider terminal events race safely so one Generation resolves exactly once.
- [x] Stop controls are available wherever the corresponding Active Generation is visible, including after reconnect.
- [x] Stop All is shown only when more than one sibling is active at the response position.
- [x] Client subscription cancellation remains separate and never invokes Stop implicitly.
