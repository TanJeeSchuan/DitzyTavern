# Fix 1 — Derive client types from contract

Status: resolved
Worktree: D:\Projects\DitzyTavern-wt\a-contract-types
Branch: fix/1-contract-types
Base: 31537ae
Spec of record: D:\Projects\DitzyTavern\.scratch\handoff-ditzytavern-fixes.md → section "Fix 1 — contract-types"
Repo rules: D:\Projects\DitzyTavern\AGENTS.md · Context: D:\Projects\DitzyTavern\CONTEXT.md · Standards: D:\Projects\DitzyTavern\CODING_STANDARDS.md

## Objective

Collapse the client's hand-duplicated type layer by deriving it from the shared TypeBox contract, and fix two known behavioral drifts. Where stated, types only — no runtime behavior/URL/validation changes.

## Ownership (merge playbook — violating this causes merge conflicts)

- MAY touch: `src/client/chat-history.ts`, `src/client/import-chat.ts`, `src/client/import-chat-flow.ts`, `src/client/cast/definition.ts`, `src/client/character-library/definition.ts`, `src/shared/**` (additive), NEW `src/client/lib/json-guards.ts`, their `.test.ts`
- MUST NOT touch: any `.tsx`, `src/client/conversation.ts`, `src/client/character-library.ts`, `src/client/new-chat.ts`, `src/client/workspace.ts`, `src/client/lib/sse.ts`, `src/styles/**`, `src/server/**`

## TODOs

- [x] 1. Derive client payload types from TypeBox contract schemas. `src/client/chat-history.ts` and `src/client/import-chat.ts` re-declare server payload shapes as parallel local interfaces (e.g. `ChatImportDuplicateMatch`, `ChatImportPreview`, receipt shapes) and hand-validate JSON. Real schemas exist as TypeBox (`t.Object`) in `src/shared/contract/chat-import.ts` and `src/shared/contract/conversation-schema.ts`. Add named `Static<typeof ...>` exports to the schema files where needed, then make the client modules import those types instead of declaring their own. Keep the hand-rolled runtime validation functions exactly as they are (deliberate transport seam) — types only. If a client interface has no contract counterpart, leave it and note it in the report. No runtime behavior/URL/validation changes.
- [x] 2a. Dedupe `UNKNOWN_IMPORTED_AUTHOR_NAME` (duplicated at `src/server/sillytavern/import-projection.ts:38` and `src/client/import-chat-flow.ts:30`). Put it in a tiny shared module under `src/shared/` (style: see `src/shared/cast.ts`, `src/shared/generation-overrides.ts`) and import from both sides.
- [x] 2b. Dedupe `openingsFromText`, duplicated with divergent behavior: `src/client/cast/definition.ts:26-27` trims lines, `src/client/character-library/definition.ts:29` does not. Extract ONE shared function (keep the trimming variant) into `src/client/lib/` and import from both. If a test fails only on whitespace, adjust the shared function to preserve tests; otherwise report.
- [x] 3. (Optional — only if trivial) Dedupe the byte-identical JSON guards (`isRow/isString/isNumber/isBoolean/isStringArray`, import-chat.ts:149-164 ≡ chat-history.ts:153-168) into `src/client/lib/json-guards.ts`. Defer if risky; items 1–2 are the priority.

## Verification

- `bunx tsc --noEmit`
- `bun test` for import-chat-flow / import-chat / chat-history tests
- `bun run lint`
- grep: nothing imports the deleted local interfaces

## Commit

`git add -A && git commit -m "Derive client import/history types from shared contract schemas"`

## Review (your ONE fanout — exactly once, after the commit)

Spawn the `code-reviewer` agent via the subagent tool with:

- Range: `31537ae..HEAD` in worktree `D:\Projects\DitzyTavern-wt\a-contract-types`
- Spec: this ticket + handoff section "Fix 1 — contract-types" + `D:\Projects\DitzyTavern\CODING_STANDARDS.md`
- Intent: type-only derivation from the shared contract; zero runtime changes; two shared-module dedupes.

Fix blocking findings, re-verify, commit fixes.
