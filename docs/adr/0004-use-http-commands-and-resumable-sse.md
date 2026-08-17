# Use revisioned HTTP commands and resumable SSE

Clients will mutate server-owned Conversations through HTTP commands carrying an expected Revision, while server-to-client state changes and Generation output flow through resumable Server-Sent Events. This matches the asymmetric traffic, keeps command validation in ordinary request-response semantics, and avoids designing WebSocket-specific acknowledgement, ordering, and reconnection protocols.

Each SSE event has an ordered event ID. Reconnecting clients may present their last received ID so the server can replay missed events or return current state when replay is unavailable.

The persisted current Conversation state and Revision are authoritative. SSE events are retained only in a bounded replay buffer; when a requested event is unavailable, or after server restart, the client receives a fresh Conversation snapshot rather than replaying a permanent domain-event history.
