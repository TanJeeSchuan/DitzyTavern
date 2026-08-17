# Center the server on a deep Conversation module

The server's primary seam will be a deep Conversation module exposing a small interface for obtaining a snapshot, executing a revisioned command, and subscribing to ordered events. It owns Conversation invariants, Participants, Control, Messages, Variants, parallel Generation coordination, SQLite transactions, and event publication.

Elysia HTTP and SSE routes are thin adapters across this seam rather than alternate locations for application behavior. Direct tests exercise the same Conversation interface as production callers.
