# Architecture enforcement

`bun run check` is the local and CI entrypoint for repository policy. It runs
Oxlint, the custom rule tests, the whole-repository contract audit, both
TypeScript projects, and the Bun tests. Clone detection is a separate advisory
command.

The `ditzy` Oxlint plugin owns five project rules:

- `no-contract-definition-outside-contract` rejects TypeBox schema construction
  in client and server consumers. Canonical schemas belong in
  `src/shared/contract/**`.
- `no-layer-dependencies-in-shared` rejects server, client, Elysia, and Bun
  dependencies from production files under `src/shared/**`, including
  type-only imports. Shared code remains independent of layer-specific APIs.
- `no-server-runtime-imports-in-client` restricts client imports of server
  modules to type-only imports, keeping runtime dependencies behind the
  transport boundary.
- `no-hand-written-wire-guards` rejects property-by-property decoders in
  migrated client transport modules when a function guards an object with
  `isRow` and then reads its fields by hand. Schema-based decoding with
  `Value.Decode` is the replacement.
- `no-manual-conversation-transaction` rejects direct Conversation transaction
  construction outside the `runConversationTransaction` owner.

The `no-contract-definition-outside-contract` Oxlint rule is the primary hard
gate for schema ownership. `scripts/check-contract-ownership.ts` repeats a
narrower `Type.Object` ownership check as a safety net, so that part can also
fail `bun run check`. Its distinct job is advisory: it fingerprints interfaces,
object type aliases, and TypeBox object schemas to warn about possible duplicate
cross-layer shapes. Equal shapes can represent different concepts, so those
matches never fail the command.

The audit uses the stable TypeScript 5.9 compiler API through the `typescript5`
alias because the application's TypeScript 7 package does not expose the
classic compiler API.

## Existing violations

The five rules are fully enforced with no baseline violations: the Elysia
route adapters live in `src/server/contract/**` and import every wire schema
from `src/shared/contract/**`, the migrated client transports decode payloads
with `Value.Decode` against the canonical schemas, and every Conversation
write runs through `runConversationTransaction`. `bun run check` is green.

## Clone and dead-export checks

JSCPD runs as an advisory report, not a gate: `bun run check:clones` writes a
console and SARIF clone report, but the `check` pipeline does not run it and
nothing fails on its output. Duplicated syntax is evidence, not a verdict —
deciding whether a reported clone deserves an abstraction is a human review
call, because DRY is about duplicated knowledge rather than duplicated syntax.
There is no blanket percentage threshold; add a ratchet only if the report
proves to catch high-value regressions over time.

Contract schemas, database schemas, CSS, tests, fixtures, snapshots, and
migrations are excluded from the report because clone detection is not the
schema ownership mechanism.

Knip was evaluated but is not part of `check`. With the current Bun test and
barrel-export layout it reports 88 unused files and 176 unused exports, including
test entrypoints and public barrel exports. Add Knip after defining its entrypoint
and public-export policy; enabling it now would make dead-export failures noisy
and easy to ignore.
