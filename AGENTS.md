# AGENTS.md
Follow YAGNI principles, and prefer one-liner solutions.

Read `CODING_STANDARDS.md` before writing or reviewing code.

Box work (`src/boxes`, `src/box-sdk`, `src/server/box`, `src/client/box-windows`): read `docs/box-system/README.md` first.

There is `playwright-cli` installed

When you finish with the dev or e2e servers, free ports 3000 and 5173 with `bun run dev:stop`.

For UI work, follow DESIGN.md. UI tweaks get no component or snapshot tests; the user-flow e2e below is fine.

When the user asks for rapid UI iteration, keep the playwright-cli session running so screenshots stay fast.

## E2E
- `bun run test:e2e` runs Playwright (`e2e/*.spec.ts` for core flows; `src/boxes/<id>/*.spec.ts` for Box flows) against `e2e/server.ts`: one Bun server per worker, a fresh seeded SQLite database per test, Memory models unconfigured by default.
- Every provider call (chat, Decision Models over /systemone, embeddings, models, memory extraction) hits a scripted fake through the `llm` fixture; an unscripted call fails the test.
- After each test the fixture also fails if any captured Prompt Plan (from generation inspection) doesn't match a request the fake actually received. `llm.restart("crash" | "graceful")` relaunches the server on the same database; graceful shutdown uses an HTTP command because Windows signals force-kill the process.
- `llm.installBox(id)` copies `e2e/fixtures/boxes/<id>/`, built by the global setup with `box:build`, into the worker's plugin folder; a `llm.restart` loads it, and the next test's reset empties the folder.

## Ticket implementation (if implementing following tickets, ignore if no tickets exist)
- Remember to edit the tickets to tick the TODOs on the way and update statuses during implementing

## Database persistence
- Clearing database tables is cheap, this is a dev environment, you can just not preserve the data if you find it annoying to migrate manually

## Database seeding and teardown
- `bun run db:seed` inserts test data. It is idempotent: it skips when the `character` table already contains rows.
- `bun run db:teardown` removes exactly the rows the seed created. It matches on the seed values (never deletes all rows), so user-created data is left untouched.
- Whenever you add seed data, generate an equivalent teardown script for it. The teardown must:
  - import the same data arrays from the seed module, so the two can never drift apart;
  - match rows by the exact seed values, never by table-wide deletes;
  - delete dependent rows first (junction tables before parent tables);
  - be wired into `package.json` next to the seed script.
- If the seed changes (new tables, fields, or rows), update the teardown in the same change.
