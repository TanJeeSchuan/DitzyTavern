# 09 — Add server-owned Stop and Stop All

**What to build:** Replace browser-request abortion with explicit server-owned cancellation. Users should be able to stop one selected Generation or all parallel siblings while preserving useful partial writing and applying the same cleanup rules across every client.

**Blocked by:** 05 — Move Sibling Generation into the Active Generation lifecycle; 06 — Checkpoint and recover Active Generations.

**Status:** ready-for-agent

- [ ] Stop targets one identified Active Generation and Stop All targets every Active Generation at the response position.
- [ ] Cancellation is an explicit server command and does not depend on which client started or currently observes Generation.
- [ ] Cancelling one parallel sibling does not cancel another sibling.
- [ ] Cancelling a Generation with Content or Reasoning Content forces a final checkpoint and persists an interrupted Variant.
- [ ] Cancelling a zero-output Tail or Continuation Generation removes its provisional model Message while retaining accepted human input.
- [ ] Cancelling a zero-output sibling removes its Provisional Variant and restores the correct prior selection.
- [ ] Cancellation does not persist a provider error message unless a distinct non-cancellation failure also occurred.
- [ ] Stop and provider terminal events race safely so one Generation resolves exactly once.
- [ ] Stop controls are available wherever the corresponding Active Generation is visible, including after reconnect.
- [ ] Stop All is shown only when more than one sibling is active at the response position.
- [ ] Client subscription cancellation remains separate and never invokes Stop implicitly.

