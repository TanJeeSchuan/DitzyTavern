# Architecture enforcement

`bun run check` is the local and CI entrypoint for repository policy. It runs
Oxlint, the custom rule tests, both Knip scans, the clone baseline check, the
stylesheet check, both TypeScript projects, the Bun tests, and the e2e harness tests.

The `ditzy` Oxlint plugin enforces these rules.

- `no-box-boundary-imports` keeps each Box to its own folder, by relative
  path, and its layer's Box SDK, by `@/` path; only tests import from
  `src/boxes`.
- `no-contract-definition-outside-contract` rejects TypeBox schema construction
  in client and server consumers. Canonical schemas belong in
  `src/shared/contract/**`.
- `no-layer-dependencies-in-shared` rejects server, client, Elysia, and Bun
  dependencies from production files under `src/shared/**`, including
  type-only imports. Shared code remains independent of layer-specific APIs.
- `no-server-runtime-imports-in-client` restricts client imports of server
  modules to type-only imports, keeping runtime dependencies behind the
  transport boundary.
- `no-manual-conversation-transaction` rejects direct Conversation transaction
  construction outside the `runConversationTransaction` owner.
- `no-conversation-internal-imports` rejects imports of Conversation internals
  and of the Message, Variant, and Active Generation tables from outside the
  Conversation module; other modules use its public barrel and read seams.
- `no-conversation-table-writes` rejects direct Drizzle inserts, updates, and
  deletes on Conversation-owned schema tables outside the Conversation module.
- `no-type-alias-rename` rejects aliases of bare type references and named
  exports that rename their binding.
- `no-reexport-module` rejects modules made entirely of re-exports. Box SDK
  entry points are exempt.
- `no-raw-server-fetch` rejects use of the global `fetch` in production server
  code outside the shared Model Client transport and listed transport owners.
- `no-unguarded-box-hook` rejects direct calls to recognized Box hook members
  outside their guard owners and listed callers of checked hooks.

The new rules list existing exceptions beside their reasons in
`tools/oxlint/ditzy/rules/`.

## Stylesheet check

`scripts/check-stylesheets.ts` resolves custom properties declared across
`src/**/*.css`, including Tailwind `@theme` blocks. It rejects an undeclared
`var()` with no fallback. The script lists the properties that Radix Select and
SwipeBrowser supply at runtime. It also rejects Tailwind `dark:` utilities in
source files because the built-in variant follows the OS color scheme. Use
`data-theme` selectors to follow the app setting.

## Clone and dead-export checks

`bun run check` fails on a clone that is not in `.jscpd-baseline.json`
(`scripts/check-clones.ts`). Existing clones are recorded, not fixed: a recorded
clone may shrink or shift within its file, but a new one fails. After a refactor
that removes duplication or renames a file holding a recorded clone, rewrite the baseline with `bun scripts/check-clones.ts --write-baseline`.
`bun run check:clones` still writes the full console and SARIF report. Whether a
reported clone deserves an abstraction is a review call, because DRY is about
duplicated knowledge rather than duplicated syntax.

Contract schemas, database schemas, CSS, tests, fixtures, snapshots, and
migrations are excluded from the report because clone detection is not the
schema ownership mechanism.

`bun run check` runs Knip twice: `knip --production`, which reports code only
tests reach, and a full `knip` scan that includes tooling and the browser harness.
`knip.json` lists the entry points. Exports kept on purpose are allowlisted there,
each with its reason: Box SDK surface, and live seams that tests or scripts import.
