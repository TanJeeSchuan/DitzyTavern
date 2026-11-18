# T2: Deletions

Status: IN PROGRESS

Blocked By: T1

Model: Sol 6.1 high.

Nothing here changes behaviour except slice c, which removes a command-line script. Before deleting a name, search `src`, `e2e` and `scripts` for it yourself; a scout's "no caller" is a lead.

Read the "Kept surface" rule in the README first. Several scout findings list things the owner is keeping.

## Slice a: server code with no production reader

- Conversation module: report 17, F8, **except** the three small Participant commands, which stay with their tests. That leaves the unused `readChatVariants` option, the `loadMessageRows` modes only the test fixture uses, exports with no outside caller, the unreachable branch in `delete-variant.ts`, and the one-line wrappers.
- Generation runtime: `controller`/`signal`, `isStopRequested`, `retainedEvents` and `GenerationRuntimeScheduler`. Report 11, finding 12; the tests to rewrite are in report 23, F7.
- Shared JSON helpers: the three unused `generationJson*` functions, and `shared/generation-json.ts`, a one-line re-export whose callers should import `contract/json-value` directly. Report 11, finding 14.
- Contract: unused schemas and type aliases, the barrel re-exports in `contract/index.ts`, rename-only aliases. Report 18, finding 10; report 24, F6.
- SillyTavern import: the two `StagedRecord` fields nothing reads, and the `sillytavern/index.ts` barrel down to what outside code imports. Report 20, findings 3 (fields only) and 14.
- Connection secrets: exports nothing imports. Report 20, finding 13 (un-export only; leave the key handling).

## Slice b: client, styles and lint

- Unused shadcn exports in `src/components/ui`. Report 19, finding 7. `box-sdk/client.ts` re-exports a named subset; keep everything it names.
- Unreachable CSS. Report 22, F1.
- The `dark` custom variant, the 33 `dark:` utilities, the sidebar theme bridges and the two unused tokens. Report 22, F8.
- The lint rules `no-module-mocking` and `no-overlong-code-lines`, the latter's test, and their entries in `oxlint.config.ts`. The sentence about overlong lines in `CODING_STANDARDS.md` stays.

## Slice c: the CLI import

Delete `src/server/sillytavern/import.ts`, `src/server/database/import-chat.ts`, the `db:import` script and `defaultImportResolution`. Move `chatNameFromFilename` into `staged.ts`. Report 20, finding 1.

Tests that seed through `importSillyTavernChat` switch to the staged path; `staged-commit.test.ts` already has a helper for it. Report 26, F5 lists what `import.test.ts` asserts that `adapter.test.ts` already owns: keep the database-seam assertions and drop the restated projection.

Amend ADR 0025 and ADR 0027: they name the developer import as a second path the shared projection must not drift from. Say it was removed on 2026-11-17 because an API-based agent surface will replace it, and that the browser import is the only path.

## Rejected

- Deleting the Box `upgrade` hook or its tests in `box/schema-check.test.ts`.
- Deleting Box SDK exports that no built-in Box uses.
- Changing the import flow's client state (`closing` phase, `begin` action): not scheduled.

## TODO

- [x] Slice a, PR
- [ ] Slice b, PR
- [ ] Slice c, PR, with the two ADR amendments

## Acceptance

Typecheck and the unit suite pass on each slice with no test deleted except those of deleted code. `git grep -n 'db:import' -- package.json README.md AGENTS.md docs` shows only the ADR amendments.

## Outcome

### Slice a

Removed unused Conversation and Generation runtime paths, unused contract schemas and aliases, the JSON re-export, unused import and Connection Secret exports, and two unread staged import fields.

The test snapshot owns the raw Variant and Message data read. Its imports of Conversation internals have test-fixture-only lint exceptions. Runtime tests verify cancellation, checkpoint ordering, and replay through callbacks and subscriptions. `GenerationBody` and `MacroVariablesEditBody` still have test callers.

- `bun run test:files <file>` passed for 23 focused files (230 tests).
- `bun run lint <changed files>` passed with warnings on existing lines.
- `git diff 0786badc --check` passed.

CI covers typecheck and the full unit suite. Slices b and c are pending. The two existing key-length constants are outside this slice's key-handling scope.
