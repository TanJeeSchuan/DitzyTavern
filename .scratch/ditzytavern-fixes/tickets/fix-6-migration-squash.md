# Fix 6 — Migrations squash

Status: resolved
Worktree: D:\Projects\DitzyTavern-wt\f-migration-squash
Branch: fix/6-migration-squash
Base: 31537ae
Spec of record: D:\Projects\DitzyTavern\.scratch\handoff-ditzytavern-fixes.md → section "Fix 6 — migration-squash"
Repo rules: D:\Projects\DitzyTavern\AGENTS.md · Context: D:\Projects\DitzyTavern\CONTEXT.md · Standards: D:\Projects\DitzyTavern\CODING_STANDARDS.md

## Objective

Squash migration history to a single baseline from current `src/server/database/schema.ts`.

CONTEXT: `src/server/database/migrations/` = 21 SQL + 20 meta snapshots (~500 KB; 0000=1.2KB → 0020=56KB). Dev environment; AGENTS.md says clearing data is cheap. `database.ts:28-31` runs `migrate()` on every `openDatabase()`. One hand-written data migration: `0013_backfill_generation_settings.sql` (journal version "7").

## Ownership (merge playbook — violating this causes merge conflicts)

- MAY touch: `src/server/database/migrations/**`, `seed.ts` (only if folding backfill), `drizzle.config.ts` (if needed)
- MUST NOT touch: `schema.ts`, conversation, workflows, shared, client, styles

## TODOs

- [x] 1. Read `drizzle.config.ts`, `database.ts`, journal.
- [x] 2. Decide the backfill's fate: fold into `seed.ts` only if seed-shaped; if it backfills arbitrary user data, keep it as a hand-written second migration (`0001_backfill_generation_settings.sql` + journal entry) after the baseline. Explain the choice. Conservative default: keep as tiny second migration.
  - **Choice: keep as hand-written second migration.** The backfill inserts a `conversation_generation_settings` row for every *pre-existing* conversation — arbitrary user data, not seed-shaped fixtures. The seed script creates Conversations through the public native workflow, which already inserts the settings row itself (`create.ts:382`), so folding into `seed.ts` cannot cover conversations it did not create. Repo precedent exists for hand-written migrations without snapshots (old `0013`, `0018`), and `readMigrationFiles` only needs journal entries + SQL files. Carried over verbatim as `0001_backfill_generation_settings.sql` via `drizzle-kit generate --custom`.
- [x] 3. Delete `migrations/` entirely; `bun run db:generate` → single fresh `0000_*.sql` + journal + one snapshot; spot-check tables incl. active_generation and generation_replay. → `0000_heavy_hex.sql` (12.4K, 22/22 schema tables verified programmatically incl. `active_generation`, `generation_replay`) + hand-written `0001_backfill_generation_settings.sql`. Note: drizzle-kit 0.31 also emits `meta/0001_snapshot.json` for a custom migration (schema content identical to 0000, `prevId` chains correctly) — expected byproduct, sound for future `db:generate`.
- [x] 4. Prove fresh migrate works: `bun test src/server` (opens databases everywhere). → 360 pass / 0 fail across 37 files.
- [x] 5. `bun run db:seed` then `bun run db:teardown` on the dev DB. → seed inserted 6 characters + 4 Conversations; teardown removed exactly those 4 + 6; reseed succeeded afterwards (fresh worktree dev DB, both migrations applied, 4/4 chats own settings rows).
- [x] 6. Update any filename/journal references if they exist. → None exist: repo-wide grep for old/new migration tags and `meta/_journal` finds only the tool-maintained journal itself; `database.ts` references the migrations folder generically.

## Seed/teardown symmetry (AGENTS.md — mandatory if you touch seed data)

- `bun run db:seed` inserts test data and is idempotent (skips when `character` table has rows).
- `bun run db:teardown` removes exactly the seed-created rows, matched by seed values (never table-wide deletes).
- If you fold backfill data into the seed, generate an equivalent teardown update in the same change: import the same data arrays from the seed module, match rows by exact seed values, delete dependent rows first (junction tables before parent tables), wire into `package.json` next to the seed script.

## Verification

- [x] `bun test src/server` → 360 pass / 0 fail across 37 files
- [x] `bunx tsc --noEmit` → clean
- [x] generated SQL covers all schema.ts tables → 22/22, zero missing/extra (programmatic check)
- [x] `bun run lint` → oxlint clean

## Operator note (from review)

⚠️ After this squash lands, any dev database that predates it (e.g. the main checkout's `data/ditzytavern.sqlite`) will fail its next `openDatabase()` (server boot, `db:seed`, `db:teardown`) with "table already exists": the migrator applies any entry newer than the last applied `created_at`, and the fresh baseline's `CREATE TABLE` statements collide with the existing tables. Remedy: delete the dev DB file and let it regenerate — sanctioned by AGENTS.md ("clearing data is cheap"). Fresh databases are unaffected.

## Commit

`git add -A && git commit -m "Squash migration history to single baseline"`

## Review (your ONE fanout — exactly once, after the commit)

Spawn the `code-reviewer` agent via the subagent tool with:

- Range: `31537ae..HEAD` in worktree `D:\Projects\DitzyTavern-wt\f-migration-squash`
- Spec: this ticket + handoff section "Fix 6 — migration-squash" + `D:\Projects\DitzyTavern\CODING_STANDARDS.md`
- Intent: single baseline (+ at most one hand-written backfill migration); fresh-migrate proof; seed/teardown symmetry preserved.

Fix blocking findings, re-verify, commit fixes.
