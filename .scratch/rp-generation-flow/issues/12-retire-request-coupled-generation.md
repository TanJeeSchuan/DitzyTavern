# 12 — Retire the request-coupled Generation path

**What to build:** Complete the migration to one server-owned Generation system. The workspace should use only authoritative start, subscribe, resume, Send, Continue, Sibling, Stop, and Preview behavior, with the legacy browser-coupled stream and local-only Generation state removed.

**Blocked by:** 08 — Add Assistant-prefill continuation; 09 — Add server-owned Stop and Stop All; 10 — Add older Variant Preview mode; 11 — Expose active inspection and durable Generation provenance.

**Status:** ready-for-agent

- [ ] Every workspace Generation action starts or mutates server-owned Generation state through the final typed contract.
- [ ] The client no longer owns an abort controller whose cancellation terminates provider work.
- [ ] Local-only streaming placeholders are replaced by authoritative Provisional Variants and subscribed events.
- [ ] The compatibility route or adapter introduced during expansion is removed once no caller depends on it.
- [ ] Tail, Send-and-Generate, Continue, Sibling, Stop, Stop All, reconnect, and Preview flows work together through the final client workspace.
- [ ] Switching Chats during Generation leaves server work running and the original Chat reloads the correct active or terminal state.
- [ ] Settings and prompt inspection expose Safety allowance and Continuation controls through the normal workspace hierarchy.
- [ ] Fresh and migrated databases satisfy Active Generation, checkpoint, and Generation Settings invariants.
- [ ] No duplicate provider request occurs during reconnect, replay fallback, conflict handling, or retry after zero output.
- [ ] Provider credentials, headers, URLs, and raw failures remain absent from all client-visible contracts.
- [ ] End-to-end contract tests cover complete, partial, zero-output, length-limited, stopped, disconnected, restarted, and parallel-sibling outcomes.
- [ ] Client state tests cover Preview mode alongside authoritative Variant selection and history reload.
- [ ] Obsolete request-coupled code and tests are removed only after replacement coverage is green.
- [ ] The complete test, type-check, lint, and build suite passes.
