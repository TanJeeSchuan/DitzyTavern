# 11 — Expose active inspection and durable Generation provenance

**What to build:** Let users inspect what an Active Generation is doing and understand how a terminal Variant was produced. Active details should include the exact provider-neutral plan and budget, while durable details retain only compact safe provenance.

**Blocked by:** 02 — Budget Prompt Plans with tokenx; 04 — Make Generation subscriptions resumable; 05 — Move Sibling Generation into the Active Generation lifecycle; 06 — Checkpoint and recover Active Generations; 07 — Add instruction-based Continuation Generation.

**Status:** ready-for-agent

- [ ] Any connected client can inspect an Active Generation by its stable identity.
- [ ] Active inspection returns the exact captured provider-neutral Prompt Plan used by that Generation.
- [ ] Active inspection identifies Tail, Sibling, or Continuation intent and the captured controlled Participants.
- [ ] Active inspection exposes Token estimate, response budget, Safety allowance, and omitted history.
- [ ] Parallel siblings expose distinct plans, settings, event positions, and targets.
- [ ] Terminal Variant details retain effective Generation Settings, safe Profile identity and Revision, resolved backend and adapter, model ID, normalized usage, finish reason, status, and interruption cause.
- [ ] Credentials, custom-header values, request URLs, raw provider bodies, and other secrets never appear in active inspection, Variant provenance, errors, or events.
- [ ] The complete Prompt Plan and Active Generation record remain available only through the bounded replay period.
- [ ] Cleanup removes active-only inspection data without removing compact Variant provenance.
- [ ] Generated and continued Messages expose their provenance through the existing details hierarchy.
- [ ] Length-limited and interrupted outcomes have clear contextual presentation.
- [ ] Contract tests assert provenance through a positive allow-list and explicit secret absence checks.

