# Use SQLite for authoritative structured state

SQLite stores Characters, Participants, Conversations, Messages, Variants, Revisions, application settings, and metadata for managed files. Its transactions enforce revision checks, ordering, active-response concurrency, and Message-to-Variant ownership atomically, while opaque assets and Exact Source Artifacts live as files outside SQLite.

The implementation will use Bun's built-in `bun:sqlite` driver directly with strict parameter binding, WAL mode, prepared statements, and hand-written SQL migrations. No ORM will define a second persistence model over the domain.

> Superseded in part by ADR-0024 (adopt Drizzle ORM and drizzle-kit) — the driver choice stands; the "no ORM" constraint is replaced.
