# 07 — Harden streamed Generation lifecycle outcomes

**What to build:** Make ordinary streamed Generation preserve useful partial work and terminate predictably across cancellation, inactivity, reasoning, provider limits, and transport failures without hidden retries or fallbacks.

**Blocked by:** 06 — Generate a complete streamed Variant through the active Profile.

**Status:** complete

- [x] No transport failure automatically retries, changes Backend, changes Adapter, or changes Profile after outbound work begins.
- [x] User cancellation affects only the targeted Generation and leaves the Conversation immediately usable.
- [x] Stream inactivity defaults to 120 seconds, can be increased or disabled, and has no total-duration limit while recognized activity continues.
- [x] Valid visible deltas, reasoning deltas, usage events, and SSE keepalive comments reset inactivity; arbitrary partial bytes do not.
- [x] Recognized separate reasoning is streamed and persisted as collapsible Reasoning Content distinct from visible answer text.
- [x] An unrecognized reasoning shape is omitted while otherwise valid visible content continues.
- [x] A failure before any visible Content or Reasoning Content removes the empty provisional Variant and restores the previous selection.
- [x] A failure after either output preserves the Variant as interrupted.
- [x] `finish_reason: length` becomes a length-limited terminal outcome with compact raw finish metadata and no automatic continuation.
- [x] Sanitized/bounded provider errors remain actionable without leaking response headers, request bodies, credentials, or custom-header values.
- [x] Workflow tests cover complete, cancelled, inactive, partial, reasoning-only, unknown-reasoning, length-limited, and failed streams through normalized external outcomes.
