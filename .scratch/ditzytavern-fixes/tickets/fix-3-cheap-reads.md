# Fix 3 — Cheap reads for getGenerationSettings

Status: resolved
Worktree: D:\Projects\DitzyTavern-wt\c-cheap-reads
Branch: fix/3-cheap-reads
Base: 31537ae
Spec of record: D:\Projects\DitzyTavern\.scratch\handoff-ditzytavern-fixes.md → section "Fix 3 — cheap-reads"
Repo rules: D:\Projects\DitzyTavern\AGENTS.md · Context: D:\Projects\DitzyTavern\CONTEXT.md · Standards: D:\Projects\DitzyTavern\CODING_STANDARDS.md

## Objective

`src/server/conversation/index.ts:145-155` `getGenerationSettings` runs the full 8-query snapshot read (~260 lines in snapshot.ts) purely as an existence check, discards it, then builds a second `connectConversationDatabase` for `readConversationGenerationSettings`. Replace with a cheap existence check and a single connection.

## Ownership (merge playbook — violating this causes merge conflicts)

- MAY touch: `src/server/conversation/index.ts`, `src/server/conversation/snapshot.ts`, their `.test.ts`
- MUST NOT touch: `internal.ts`, `commands/**`, `types.ts`, workflows, shared, client, database

## TODOs

- [x] 1. Add cheap `conversationExists(db, conversationId)` (single-row chatTable select) in `src/server/conversation/snapshot.ts` (NOT internal.ts — owned by fix 2) and export it.
- [x] 2. Rewrite `getGenerationSettings` in index.ts: ONE `connectConversationDatabase` instance; `conversationExists` for the undefined path; then `readConversationGenerationSettings` with the same instance. Preserve exact return semantics (check generation-settings.ts; tests confirm).
- [x] 3. Grep for other full-snapshot-as-existence-check sites in `src/server/conversation` + `workflows`; fix any found. Known non-candidate to leave alone but report: `src/server/connection-settings/index.ts:371-386` requireRevision (second module instance for error state — out of scope).
  - Grep verdict: every other `readConversationSnapshot`/`getSnapshot` site in `src/server/conversation` and `workflows` consumes the snapshot (returns it or reads fields); the only existence-only site was the `getGenerationSettings` target fixed in TODO 2. No further fixes in scope.
  - Reported, out of scope/ownership: `src/server/application/generation-coordinator.ts:225` uses `getSnapshot(...) === undefined` purely as an existence check (outside the ticket's grep scope of conversation+workflows and outside this fix's ownership map).
  - Known non-candidate confirmed: `src/server/connection-settings/index.ts:371-386` requireRevision builds a second module instance only to embed current settings in the error state — not an existence check.

## Verification

- `bunx tsc --noEmit`
- `bun test src/server/conversation src/server/workflows src/server/connection-settings`
- `bun run lint`

## Commit

`git add -A && git commit -m "Replace full-snapshot existence check with cheap conversationExists"`

## Review (your ONE fanout — exactly once, after the commit)

Spawn the `code-reviewer` agent via the subagent tool with:

- Range: `31537ae..HEAD` in worktree `D:\Projects\DitzyTavern-wt\c-cheap-reads`
- Spec: this ticket + handoff section "Fix 3 — cheap-reads" + `D:\Projects\DitzyTavern\CODING_STANDARDS.md`
- Intent: pure read-path optimization; return semantics byte-identical; no API changes.

Fix blocking findings, re-verify, commit fixes.
