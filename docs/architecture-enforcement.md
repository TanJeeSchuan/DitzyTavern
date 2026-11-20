# Architecture enforcement

`bun run check` is the local and CI entrypoint for repository policy. It runs
Oxlint, the custom rule tests, both TypeScript projects, and the Bun tests.
Clone detection is a separate advisory command.

The `ditzy` Oxlint plugin owns six project rules:

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

The `no-contract-definition-outside-contract` Oxlint rule is the only gate for
schema ownership.

## Existing violations

The six rules are fully enforced with no baseline violations: the Elysia
route adapters live in `src/server/contract/**` and import every wire schema
from `src/shared/contract/**`, the migrated client transports decode payloads
with `Value.Decode` against the canonical schemas, and every Conversation
write runs through `runConversationTransaction`. `bun run check` is green.

## Clone and dead-export checks

`bun run check` fails on a clone that is not in `.jscpd-baseline.json`
(`scripts/check-clones.ts`). Existing clones are recorded, not fixed: a recorded
clone may shrink or move, but a new one fails. After a refactor that removes
duplication, rewrite the baseline with `bun scripts/check-clones.ts --write-baseline`.
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
