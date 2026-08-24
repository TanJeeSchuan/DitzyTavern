# AGENTS.md

There is `playwright-cli` installed

For UI work, remember to refer to DESIGN.MD

## Ticket implementation
- Remember to edit the ticket files to tick the TODOs on the way and update statuses during implementing

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