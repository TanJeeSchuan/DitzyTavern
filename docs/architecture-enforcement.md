# Architecture enforcement

`bun run check` is the local and CI entrypoint for repository policy. It runs
Oxlint, the custom rule tests, the whole-repository contract audit, both
TypeScript projects, the Bun tests, and implementation clone detection.

The `ditzy` Oxlint plugin owns four project rules:

- `no-contract-definition-outside-contract` rejects TypeBox schema construction
  in client and server consumers. Canonical schemas belong in
  `src/shared/contract/**`.
- `no-runtime-imports-in-shared` rejects new server, client, Elysia, and Bun
  runtime imports from production files under `src/shared/**`.
- `no-hand-written-wire-guards` rejects long property-by-property decoders in
  migrated client transport modules. Schema-based decoding with `Value.Check`
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

There is no architectural baseline. Existing runtime imports under `src/shared`,
hand-written decoders in migrated transports, and direct Conversation
transactions fail `bun run lint`. CI stays red until the owning code is moved or
derived from the canonical abstraction. This is intentional: the checks describe
the required architecture, not only regressions added after this file.

## Clone and dead-export checks

JSCPD covers implementation and TSX template code. Contract schemas, database
schemas, CSS, tests, fixtures, snapshots, and migrations are excluded because
clone detection is not the schema ownership mechanism. The initial 3.3 percent
threshold sits just above the repository's 3.21 percent implementation baseline
and still reports the known generation lifecycle and client command clones.

Knip was evaluated but is not part of `check`. With the current Bun test and
barrel-export layout it reports 88 unused files and 176 unused exports, including
test entrypoints and public barrel exports. Add Knip after defining its entrypoint
and public-export policy; enabling it now would make dead-export failures noisy
and easy to ignore.
