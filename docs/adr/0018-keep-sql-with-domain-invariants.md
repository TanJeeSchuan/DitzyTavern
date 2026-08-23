# Keep SQL with the modules that own domain invariants

A small Database module will open `bun:sqlite`, configure pragmas, and run hand-written migrations. Conversation and Character Library implementations will own their prepared statements and transactional SQL directly; version one will not add generic repository interfaces over the single SQLite implementation.

> Superseded in part by ADR-0024 (adopt Drizzle ORM and drizzle-kit) — migrations become drizzle-kit generated, and Drizzle replaces hand-written prepared statements; the "no generic repository interfaces" rule stands.
> Terminology amended by ADR-0017 (isolate the Character Library) — the reusable identity surface is the Character Library; there is no parallel Profile implementation.
