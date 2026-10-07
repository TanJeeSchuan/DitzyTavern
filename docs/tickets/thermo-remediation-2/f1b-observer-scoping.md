# The write observer is per database and the composition is loud

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F1 residue (merged F1 remediation left these) + batch-2 review.

## Goal

The Conversation write observer from the F1 remediation shipped as **process-global** state, so the test suite passed only by cross-file leakage: `bun test src/server/workflows/send-generation.test.ts` alone was 6 pass / 1 fail on the very same commit where the full suite was green. This ticket scopes the observer per database, makes the composition contract fail-fast instead of silently dropping, closes the delete-gate race, and restores the old sweep's orphaned-work guarantee on removal paths.

## Mechanics

**Machinery removed**

- The module-level `let conversationWriteObserver` + process-wide setter in `conversation/commands/transaction.ts` — one install anywhere leaked into every other composition in the process.
- The silent `conversationWriteObserver?.(...)` delivery (`?.` dropped a reported change whenever nothing was installed).
- The registered-variant scan residue in `memory/sync.ts` (`registeredMemoryVariants(database).filter(...)`) — the report already names the removed Variant ids, so the scan-and-filter rediscovery is gone; `abortMemoryWork(database, change.removedVariantIds)` abandons exactly the reported removals. (`registeredMemoryVariants` itself stays: `memory/collections.ts` still scans the full registry for its indexing sweep.)
- The flagged unused `InvalidMemorySourceError` import — located by linter and by `git grep` at the pinned commit `c0b3fb6`: it does not exist in this tree (the description predates the current state); `bun run lint` shows no such finding. No import was removed because none exists.

**Machinery introduced**

- Per-database registration: `WeakMap<Database, Observer>` lives inside `transaction.ts`; `observeConversationWrites(database, observer)` registers for that one database and the delivery looks up the observer of the transaction's own database. This mirrors the merged F5 container's per-database scoping without coupling Conversation to `application/process-state` (no upward dependency; the WeakMap stays in the deep module).
- The named composition error `ConversationWriteObserverMissingError` — a write that reports a change with no observer registered for its database **throws** and the transaction rolls back, so missing wiring can never pass unnoticed. Exported through the Conversation barrel.
- The missing change report: `removeConversationGeneration` now reports `removedVariantIds: [active.variant_id]` — the sibling Variant alone for a Sibling removal, or the provisional Variant for a Tail/Continuation removal (a provisional target Message owns exactly that one Variant: Sibling acceptance is denied while a non-sibling Active Generation exists, and a provisional target Message carries no captured historical Control pair to serve as a sibling target, so no other Variant rows can be deleted unreported). `removeActiveGenerationTargetInTransaction` is shared with the zero-output Stop seams, whose reports already covered the same ids.

**Composition migrations**

- `app.ts` installs the sync for the application database: `observeConversationWrites(database, syncMemorySources)`.
- The three contract memory suites (`memory.test.ts`, `memory-indexing.test.ts`, `memory-lifecycle.test.ts`) keep their installs, now correctly scoped to their own per-test database (verified: each fails with its install removed, so they are genuine self-compositions; the report's "delete any installed to make other files pass" found none to delete).
- Test compositions whose databases see change-reporting writes now install their own observer explicitly (the same uniform `observeConversationWrites(database, syncMemorySources)` line as `app.ts` and the contract suites): 42 files across `application/`, `contract/`, `conversation/`, `database/`, `sillytavern/`, and `workflows/` — each measured by run-failure before the install, so every installed composition is one whose writes actually report changes. Files that open databases but never report are untouched; fail-fast keeps them honest (any future change report in an uninstalled composition throws in its own test).
- The e2e harness composes through `createApp`, so the production install covers it; no e2e wiring changed.

## Behavior change (the one documented for this ticket)

`deleteConversation` reads the Active-Generation guard **inside** the write transaction (via the shared `hasActiveGenerationFromConnection` probe) instead of outside it: a Generation starting between the old probe and the transaction no longer slips past the guard, so the delete now refuses instead of writing into a Chat with a running Generation. Producers of a Generation for the same Chat are not affected; the check simply joins the rest of the transaction's guarded reads.

Removals now also abandon in-flight Memory work for their deleted Variants (restoring the pre-refactor sweep guarantee that the report-driven design had lost), and the sync abandons exactly the reported removals. Everything else — wire shapes, ordering, provider behavior, e2e fakes — is unchanged; memory sync fires during e2e exactly where `createApp` composes it as before.

## Ticket-context note

The `==[HUMAN APPROVED]==` comment in `transaction.ts` describing the observer was reworded minimally where it would otherwise have described the removed global factory — the marker tag itself is preserved for the later marker-migration wave. New comments in this PR are marked the same way per the comment policy.

## Verification

- `bun test src` — 1340 pass / 0 fail (154 files; master was 1336 tests, +4 pinning tests, 0 removed).
- `bun test src/server/workflows/send-generation.test.ts` alone — **7 pass / 0 fail** (master alone: 6 pass / 1 fail).
- `bun test src/server/application/generation-coordinator.test.ts` alone — **14 pass / 0 fail**.
- `bun run typecheck` — exit 0; `bun run lint` — exit 0, no findings in touched files; `bun run check:contracts` — exit 0 (advisory dedupe list unchanged from master).
- `bun run test:e2e` — 36 passed / 0 failed (including the updates restart checks).
- `rg -n 'conversationWriteObserver' src/server/conversation/commands/transaction.ts | rg 'let'` — 0 matches.
- Every `observeConversationWrites(` call site carries a database argument (production: `app.ts`; tests: per-database only).
- No production file ≥ 1,000 lines (largest: `shared/contract/conversation-schema.ts` 931).
