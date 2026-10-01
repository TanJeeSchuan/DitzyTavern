# Complexity reduction draft handoff

Status: work in progress, paused for transfer to a machine with more memory.
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

1. Run the final `bun run check` on the better machine. Attempts after RHF were interrupted by memory pressure; the typecheck log had no diagnostic but its successful exit was not confirmed. Do not treat final validation as complete.
2. Review the RHF pilot with the user, as requested. Manually verify dirty/reset behavior, authoritative updates while a local draft is dirty, save conflicts, and edits made while a save is in flight. No UI tests per project instructions.
3. Review shutdown/draining and Query mutation cancellation/cache behavior before marking the draft ready.

## Local environment notes

The existing development database failed startup migration because `conversation_memory_settings` already exists. No existing user data was deleted or migrated. Browser checks used an isolated seeded database under `/tmp/ditzy-complexity-preview`; the temporary lorebook was named `Query review book`. This temporary database is not part of the commit. A fresh environment must prepare its own database.

The server, client, and final-check process groups started for this work are stopped. Validation logs and pre-RHF copies under `/tmp` are machine-local and are not needed to check out or continue this draft.
