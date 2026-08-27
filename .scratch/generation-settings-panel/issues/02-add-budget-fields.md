# 02 — Expose Budget fields

**What to build:** Add a Budget section to the consolidated Generation panel exposing context limit, response budget, Safety allowance, and Sibling Generation limit as positive whole numbers matching their existing server validation (Safety allowance also accepts zero).

**Blocked by:** 01 — Consolidate Generation panel and expose Sampling.

**Status:** complete

- [x] A Budget section offers context limit, response budget, Safety allowance, and Sibling Generation limit as whole-number fields.
- [x] Per-field errors match the server rules: positive integers for all four, non-negative for Safety allowance.
- [x] Invalid input blocks Apply without discarding other drafted values.
- [x] Token budget consequences are reflected on the next Generation through the existing Prompt Compiler path with no new server code.
- [x] Unit tests cover the whole-number draft parser including zero-Safety-allowance acceptance and negative rejection.
- [x] `bun test` and `bun run lint` pass.

**Notes:** Draft helpers extended in [src/client/generation-settings-draft.ts](../../../src/client/generation-settings-draft.ts) with tests colocated; Budget section added to [src/client/workspace/GenerationPanel.tsx](../../../src/client/workspace/GenerationPanel.tsx) between Sampling and Continuation. Budget drafts accept only canonical digit strings so blank, decimal, and exponent text land as invalid before the numeric minimum check, mirroring the server's whole-number rule; error copy reuses the exact server command messages. Verified with 529 passing tests, oxlint, `tsc --noEmit`, and a clean `vite build`.
