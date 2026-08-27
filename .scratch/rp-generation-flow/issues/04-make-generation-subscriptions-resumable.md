# 04 — Make Generation subscriptions resumable

**What to build:** Let every client observe the same server-owned Active Generation independently of the request that started it. Reloading, navigating, or disconnecting should unsubscribe only that client while Generation and authoritative streaming continue on the server.

**Blocked by:** 03 — Send through provisional Tail Generation.

**Status:** complete

- [x] Starting Generation and subscribing to its output are logically separate server operations.
- [x] Every Active Generation has a stable identifier and every normalized event has an ordered event ID.
- [x] Several clients can subscribe to one Active Generation and receive the same ordered application events.
- [x] Cancelling a subscription, navigating, reloading, or disconnecting never passes cancellation to the provider request.
- [x] Reconnecting with a known last event ID replays every retained later event in order without duplication.
- [x] When the requested replay position is unavailable, the client receives authoritative current state and continues from the live position.
- [x] The event replay buffer is bounded and is not treated as permanent domain history.
- [x] Opening another Chat does not stop Generation in the previous Chat.
- [x] The workspace can reload an Active Generation and render its Provisional Variant without relying on local accumulated text.
- [x] Malformed, duplicated, or out-of-order transport frames do not corrupt visible Generation state.
- [x] Contract tests prove that disconnecting the initiating client leaves the controlled fake provider running and another client can observe completion.

## Comments

Implemented a process-owned generation runtime with stable generation/event IDs, bounded replay, multi-client SSE subscriptions, authoritative state fallback, and revision-neutral provisional checkpoints. POST acceptance and GET subscription are separate operations; request disconnects only remove a subscriber and never abort the provider signal. The client validates SSE IDs and ignores malformed, duplicate, and out-of-order frames. Added workflow and transport tests covering replay, state fallback, and disconnecting the initiating subscriber while another observer receives completion.
