# 11 — Expose active inspection and durable Generation provenance

**What to build:** Let users inspect what an Active Generation is doing and understand how a terminal Variant was produced. Active details should include the exact provider-neutral plan and budget, while durable details retain only compact safe provenance.

**Blocked by:** 02 — Budget Prompt Plans with tokenx; 04 — Make Generation subscriptions resumable; 05 — Move Sibling Generation into the Active Generation lifecycle; 06 — Checkpoint and recover Active Generations; 07 — Add instruction-based Continuation Generation.

**Status:** complete

- [x] Any connected client can inspect an Active Generation by its stable identity.
- [x] Active inspection returns the exact captured provider-neutral Prompt Plan used by that Generation.
- [x] Active inspection identifies Tail, Sibling, or Continuation intent and the captured controlled Participants.
- [x] Active inspection exposes Token estimate, response budget, Safety allowance, and omitted history.
- [x] Parallel siblings expose distinct plans, settings, event positions, and targets.
- [x] Terminal Variant details retain effective Generation Settings, safe Profile identity and Revision, resolved backend and adapter, model ID, normalized usage, finish reason, status, and interruption cause.
- [x] Credentials, custom-header values, request URLs, raw provider bodies, and other secrets never appear in active inspection, Variant provenance, errors, or events.
- [x] The complete Prompt Plan and Active Generation record remain available only through the bounded replay period.
- [x] Cleanup removes active-only inspection data without removing compact Variant provenance.
- [x] Generated and continued Messages expose their provenance through the existing details hierarchy.
- [x] Length-limited and interrupted outcomes have clear contextual presentation.
- [x] Contract tests assert provenance through a positive allow-list and explicit secret absence checks.

Implemented the server-owned inspection read seams and HTTP routes, active capture fields for plans/budgets/participants, allow-listed terminal provenance, and the Story workspace inspection panel. The client keeps complete, length-limited, and interrupted replay records inspectable until retention cleanup expires them. Terminal resolution retains every normalized finish reason and interruption cause across successful, length-limited, provider-failed, stopped, and recovered paths. Provider diagnostics use only server-owned status and fixed response categories, never untrusted provider bodies, Content-Type values, or raw finish reasons. Added transport tests that assert exact plan/budget capture, required terminal fields, bounded-replay expiry, and explicit credential/request-override/raw-provider absence across HTTP and SSE.
