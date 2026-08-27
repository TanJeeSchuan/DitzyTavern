# 01 — Consolidate Generation panel and expose Sampling

**What to build:** Replace the Continuation primary panel with one consolidated Generation panel that keeps Continuation behavior intact and adds Sampling fields (temperature, Top P, frequency penalty, presence penalty) as optional values where empty means provider default. One whole-object revision-guarded Apply saves the complete Conversation Generation Settings aggregate.

**Blocked by:** none.

**Status:** complete

- [x] The PrimaryPanel union renames `continuation` to `generation` and every rail and panel wiring reference updates with it; no stale references remain.
- [x] The rail entry is labeled Generation and opens a panel titled Generation Settings.
- [x] The panel requires an open Chat and shows the existing explanatory note otherwise.
- [x] A Model section shows the current model ID read-only with a hint that selection happens beside the composer.
- [x] A Sampling section offers temperature, Top P, frequency penalty, and presence penalty; an empty field submits null, and out-of-range or non-numeric input shows a per-field error matching the server rule (finite value between -2 and 2).
- [x] The Continuation section keeps strategy, prefill suffix (shown only for assistant prefill), and continuation instruction behavior unchanged inside the merged panel.
- [x] One Apply action saves the complete Generation Settings object through the existing update-generation-settings command; budgets and Request Overrides round-trip unchanged.
- [x] An Apply conflict preserves the local draft, refreshes authoritative state, and explains what happened.
- [x] Save errors stay actionable without discarding any drafted value.
- [x] Unit tests cover the nullable-number sampling draft parser including blank, valid boundary values, and invalid input.
- [x] `bun test` and `bun run lint` pass.

**Notes:** Draft helper lives in [src/client/generation-settings-draft.ts](../../../src/client/generation-settings-draft.ts) with tests colocated; panel is [src/client/workspace/GenerationPanel.tsx](../../../src/client/workspace/GenerationPanel.tsx) replacing the deleted ContinuationPanel. Conflict handling upgraded from the old panel's blanket error to the ModelSelector-style draft-preservation behavior required by ADR 0023. Verified with 523 passing tests, oxlint, `tsc --noEmit`, and a clean `vite build`.
