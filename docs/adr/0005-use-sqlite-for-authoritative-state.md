# Use SQLite for authoritative structured state

SQLite will store Actor Profiles, Participants, Conversations, Messages, Variants, Revisions, and application settings. Its transactions will enforce revision checks, ordering, active-response concurrency, and Message-to-Variant ownership atomically, while the filesystem is reserved for opaque assets and explicit import/export files.

The implementation will use Bun's built-in `bun:sqlite` driver directly with strict parameter binding, WAL mode, prepared statements, and hand-written SQL migrations. No ORM will define a second persistence model over the domain.

> Superseded in part by ADR-0024 (adopt Drizzle ORM and drizzle-kit) — the driver choice stands; the "no ORM" constraint is replaced.
