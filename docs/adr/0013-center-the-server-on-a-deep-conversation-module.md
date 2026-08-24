# Center the server on a deep Conversation module

The server's primary seam is a deep Conversation module exposing a small interface for atomic aggregate creation, authoritative snapshot and history reads, revisioned commands, and bounded Generation commits. It owns Conversation invariants, Participants, Control, Messages, Variants, Generation coordination, and their SQLite transactions. Ordered event subscription remains deferred until a real consumer requires it.

Elysia routes and cross-module workflows call public domain seams rather than becoming alternate locations for Conversation behavior or writing its tables directly. Direct tests exercise the same Conversation interface as production callers.
