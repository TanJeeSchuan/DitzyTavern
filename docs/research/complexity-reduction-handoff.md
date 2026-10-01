# Complexity reduction draft handoff

Status: validation completed on Windows on 2026-10-01; ready for the user's RHF pilot review.
Base: `bcc736d` (`docs: document client and server complexity reduction opportunities`).
Source recommendations: `complexity-reduction.md` and `complexity-reduction-packages.md` in this directory.

## Implemented

- Require one shared server database across routes, memory work, generation runtimes, and imports. Remove implicit database ownership and obsolete wrappers. Drain detached generation work during coordinated shutdown before closing the database. Scope generation previews to their database.
- Derive generation settings schemas, draft fields, and conversions from existing declarations; remove redundant identity projections.
- Use `eventsource-parser` for client SSE framing and server activity monitoring. An unterminated final event is ignored, leaving the stream interrupted.
- Introduce TanStack Query for memory polling and lorebook reads, with abort signals and mutation cache updates. Conversation history and stream reconciliation remain deferred.
- Implement the React Hook Form pilot last, limited to `src/client/workspace/useGenerationSettingsDraft.ts`. Query owns authoritative settings; RHF owns draft values, dirty state, and resets. Keep lexical parsing and fresh-base save/conflict handling. No resolver package or XState adoption.

## Validation completed

- Full `bun run check` before the RHF pilot: 1,161 tests passed.
- Additional focused checks: 32 tests passed; SSE/model-client suite: 57 tests passed.
- Generation settings helper tests after RHF: 19 tests passed. These do not verify the hook's browser behavior.
- Production build with RHF passed, with a large bundle warning (approximately 1.26 MB minified).
- Lint after RHF passed with comment-approval warnings. Cast rationale comments were not falsely marked as human-approved.
- Manual browser checks: lorebook create, rename, save, and close; memory panel coverage/data loading.
- `git diff --check` passed before this handoff.

## Remaining work

Review the RHF pilot with the user, as requested. The browser checks below passed; user review is still pending. No UI tests were added.

## Follow-up validation, 2026-10-01

- Installed the locked dependencies with `bun install --frozen-lockfile`.
- Removed the obsolete `unavailable` namespace branch in `GenerationSettingsEditors.tsx`, which caused TS2367 after the hook stopped returning that state.
- Final `bun run check` exited successfully: 1,165 application tests and 50 lint-rule tests passed, including both typechecks. Comment-approval warnings and the contract audit's nine advisory matches remain.
- `bun run build` passed. The approximately 1.26 MB minified JavaScript bundle still triggers the size warning.
- Browser checks confirmed dirty state clears when an edit returns to its saved value; remote updates and revision conflicts preserve the entire local draft; retrying a conflicted save succeeds; edits made during a delayed save response remain dirty; discard restores the latest saved values; exponent text in a budget field blocks saving.
- A delayed lorebook list read was aborted by a successful rename. Releasing its stale response did not overwrite the saved cache. Reopening the book fetched an external rename. Closing Memories aborted all three pending reads.
- Reviewed shutdown ordering and database-scoped runtime ownership. The passing runtime tests cover checkpoint flushing, aborting active work, and waiting for detached work before releasing retained state.
- Standards and scoped-spec reviews found no remaining issues. `git diff --check` passed.

## Local environment notes

The original machine's development database failed startup migration because `conversation_memory_settings` already exists. No existing user data was deleted or migrated. Its browser checks used an isolated seeded database under `/tmp/ditzy-complexity-preview`.

The Windows follow-up used `%TEMP%/ditzy-complexity-review/data/ditzytavern.sqlite`, seeded from the existing seed module. Validation output is in `%TEMP%/ditzy-complexity-check.log`. These files are machine-local. The isolated API on port 3000 and Vite on port 5173 were left running for user review, with Generation Settings open in the collaborative preview. Browser request-delay instrumentation was removed.
