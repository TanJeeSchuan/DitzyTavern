# 02 — Budget Prompt Plans with tokenx

**What to build:** Give users predictable prompt preflight before provider contact. Generation should estimate one canonical representation of the Prompt Plan, apply the response budget and configurable Safety allowance, remove oldest whole history Messages when needed, and explain any omissions or rejection.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] `tokenx` is pinned and accessed only through a project-owned synchronous Token Estimator interface.
- [x] Conversation Generation Settings persist and expose a configurable Safety allowance whose default is 500 tokens.
- [x] Invalid Safety allowance values fail through the existing typed settings-validation contract.
- [x] One deterministic Estimation transcript represents the final ordered Prompt Plan with stable block and role separators.
- [x] The complete Estimation transcript is counted once per candidate rather than summing independently estimated blocks.
- [x] Preflight compares Token estimate, response budget, and Safety allowance with the configured context limit.
- [x] Over-budget candidates drop the oldest whole history Message, rebuild the plan, and re-estimate until the candidate fits.
- [x] Context reduction never splits a Message or removes the latest Human-authored Message.
- [x] A candidate that cannot fit fixed prompt content and protected recent input fails before provider contact with an inspectable size breakdown.
- [x] Prompt inspection exposes the approximate Token estimate, response budget, Safety allowance, and omitted history without claiming exact provider tokenization.
- [x] Tail and Sibling Generation tests demonstrate the correct history boundaries after reduction.
