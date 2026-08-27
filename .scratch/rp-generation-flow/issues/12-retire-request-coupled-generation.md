# 12 — Retire the request-coupled Generation path

**What to build:** Complete the migration to one server-owned Generation system. The workspace should use only authoritative start, subscribe, resume, Send, Continue, Sibling, Stop, and Preview behavior, with the legacy browser-coupled stream and local-only Generation state removed.

**Blocked by:** 08 — Add Assistant-prefill continuation; 09 — Add server-owned Stop and Stop All; 10 — Add older Variant Preview mode; 11 — Expose active inspection and durable Generation provenance.

**Status:** complete

- [x] Every workspace Generation action starts or mutates server-owned Generation state through the final typed contract.
- [x] The client no longer owns an abort controller whose cancellation terminates provider work.
- [x] Local-only streaming placeholders are replaced by authoritative Provisional Variants and subscribed events.
- [x] The compatibility route or adapter introduced during expansion is removed once no caller depends on it.
- [x] Tail, Send-and-Generate, Continue, Sibling, Stop, Stop All, reconnect, and Preview flows work together through the final client workspace.
- [x] Switching Chats during Generation leaves server work running and the original Chat reloads the correct active or terminal state.
- [x] Settings and prompt inspection expose Safety allowance and Continuation controls through the normal workspace hierarchy.
- [x] Fresh and migrated databases satisfy Active Generation, checkpoint, and Generation Settings invariants.
- [x] No duplicate provider request occurs during reconnect, replay fallback, conflict handling, or retry after zero output.
- [x] Provider credentials, headers, URLs, and raw failures remain absent from all client-visible contracts.
- [x] End-to-end contract tests cover complete, partial, zero-output, length-limited, stopped, disconnected, restarted, and parallel-sibling outcomes.
- [x] Client state tests cover Preview mode alongside authoritative Variant selection and history reload.
- [x] Obsolete request-coupled code and tests are removed only after replacement coverage is green.
- [x] The complete test, type-check, lint, and build suite passes.

Review follow-up added transport coverage for startup recovery and two parallel
Sibling outcomes. The obsolete `createGenerationCoordinator` and
`generateReply` exports were removed. A narrowly named terminal fixture helper
remains available only by direct test-module import so prompt capture, provider
event normalization, and concurrent-edit invariants can be tested without
presenting a non-authoritative workflow to product code. Unused Send and
Continuation compatibility aliases were removed as part of the same audit.
New Swipe and Details
now follow the advanced Message-action disclosure used for hover, keyboard
focus, and touch selection.
