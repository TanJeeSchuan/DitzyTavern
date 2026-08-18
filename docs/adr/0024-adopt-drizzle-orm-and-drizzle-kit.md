# Adopt Drizzle ORM and drizzle-kit

Drizzle ORM becomes the typed query layer over the existing `bun:sqlite` driver, and drizzle-kit generates SQL migration files by diffing a TypeScript schema. This supersedes ADR-0005's "no ORM" constraint and ADR-0018's "hand-written SQL migrations and no generic persistence layer" where they conflict with this decision.

The `bun:sqlite` driver remains the only database driver. Drizzle expressions may be used for queries, but hand-written SQL stays available through `sql` templates where domain invariants are clearer expressed in SQL; prepared statements and strict parameter binding remain the rule. The Database module still owns opening, pragmas, and migration application, and the migration files remain SQL.

Domain modules keep owning their queries — Drizzle replaces the boilerplate of hand-written prepared statements without introducing a generic repository interface. Schema lives in `src/server/database/schema.ts`, and domain modules that need new tables extend it; drizzle-kit generates the corresponding migration, which is reviewed like any other SQL.