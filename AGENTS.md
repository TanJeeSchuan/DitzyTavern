# AGENTS.md
Follow YAGNI principles, and prefer one-liner solutions.

There is `playwright-cli` installed

For UI work, remember to refer to DESIGN.MD, AND NO UI TESTS (component/snapshot tests for UI tweaks; user-flow e2e below is fine)

## E2E
- `bun run test:e2e` runs Playwright (`e2e/*.spec.ts`) against `e2e/server.ts`: one Bun server per worker, a fresh seeded SQLite database per test, memory off by default.
- Every provider call (chat, Decision Models over /systemone, embeddings, models, memory extraction) hits a scripted fake through the `llm` fixture; an unscripted call fails the test.
- After each test the fixture also fails if any captured Prompt Plan (from generation inspection) doesn't match a request the fake actually received. `llm.restart("crash" | "graceful")` relaunches the server on the same database; graceful shutdown uses an HTTP command because Windows signals force-kill the process.

When user asks for UI iterration / rapid iterration, keep the playwright-cli session running to keep the screenshots fast

Use Radix / Shadcn components when possible, handroll as last resort

Do not preserve backward compatibility. Remove obsolete paths. Do not create compatibility layers, fallbacks, or mitigations.

Exhaustive declarations should encode information. An exhaustive object whose values are all identical and that has no consumer is just a compiler-enforced attendance sheet. That is usually worth removing.

a structural proposal must identify the machinery removed, machinery introduced, and behavior changed. Pass previous rejected approaches into subsequent reviews. **“I can imagine another architecture” is too cheap an approval blocker.**

## Code Standards
- Tautological tests considered harmful.
- During refactors, tests for **architectural** regressions are not needed, e.g. a set of hand-writen identical declarations being unified into a single declaration doesn't need a test to detect if it regressed into it's initial state

## Ticket implementation (if implementing following tickets, ignore if no tickets exist)
- Remember to edit the tickets to tick the TODOs on the way and update statuses during implementing

## Database persistance
- Clearing database tabels is cheap, this is a dev environment, you can just not preserve the data if you find it annoying to mirgrate manually

## Database seeding and teardown
- `bun run db:seed` inserts test data. It is idempotent: it skips when the `character` table already contains rows.
- `bun run db:teardown` removes exactly the rows the seed created. It matches on the seed values (never deletes all rows), so user-created data is left untouched.
- Whenever you add seed data, generate an equivalent teardown script for it. The teardown must:
  - import the same data arrays from the seed module, so the two can never drift apart;
  - match rows by the exact seed values, never by table-wide deletes;
  - delete dependent rows first (junction tables before parent tables);
  - be wired into `package.json` next to the seed script.
- If the seed changes (new tables, fields, or rows), update the teardown in the same change.
