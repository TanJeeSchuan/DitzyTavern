# Architecture enforcement

`bun run check` is the local and CI entrypoint for repository policy. It runs
Oxlint, the custom rule tests, the whole-repository contract audit, both
TypeScript projects, the Bun tests, and implementation clone detection.

The `ditzy` Oxlint plugin owns five project rules:

- `no-contract-definition-outside-contract` rejects TypeBox schema construction
  in client and server consumers. Canonical schemas belong in
  `src/shared/contract/**`.
- `no-runtime-imports-in-shared` rejects new server, client, Elysia, and Bun
  runtime imports from production files under `src/shared/**`.
- `no-server-runtime-imports-in-client` restricts client imports of server
  modules to type-only imports, keeping runtime dependencies behind the
  transport boundary.
- `no-hand-written-wire-guards` rejects long property-by-property decoders in
  migrated client transport modules. Schema-based decoding with `Value.Decode`
  is the replacement.
- `no-manual-conversation-transaction` rejects direct Conversation transaction
  construction outside the `runConversationTransaction` owner.

`scripts/check-contract-ownership.ts` uses the stable TypeScript 5.9 compiler
API, installed under the `typescript5` alias because the application's
TypeScript 7 package does not expose the classic compiler API. It fingerprints
interfaces, object type aliases, TypeBox object schemas, and records
`Static<typeof Schema>` derivations. New schemas owned by client or server are
hard failures. Generic cross-layer shape matches are warnings because equal
shapes can represent different concepts.

## Existing violations

The four rules are fully enforced with no baseline violations: the Elysia
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
