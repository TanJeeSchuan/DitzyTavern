# Fix 2 — Shared transaction + generation seams

Status: resolved
Worktree: D:\Projects\DitzyTavern-wt\b-generation-seams
Branch: fix/2-generation-seams
Base: 31537ae
Spec of record: D:\Projects\DitzyTavern\.scratch\handoff-ditzytavern-fixes.md → section "Fix 2 — generation-seams"
Repo rules: D:\Projects\DitzyTavern\AGENTS.md · Context: D:\Projects\DitzyTavern\CONTEXT.md (read first — naming matters) · Standards: D:\Projects\DitzyTavern\CODING_STANDARDS.md

## Objective

Pure structural refactor, zero behavior change, verified by the existing suite (`src/server/workflows/generate.test.ts`, `src/server/conversation/*.test.ts`). Read CONTEXT.md first.

## Ownership (merge playbook — violating this causes merge conflicts)

- MAY touch: `src/server/workflows/**`, `src/server/conversation/**` (commands/, internal.ts, types.ts, index.ts re-exports), their `.test.ts`
- MUST NOT touch: `src/server/conversation/snapshot.ts`, `src/server/conversation/index.ts` getGenerationSettings body, `src/shared/**`, `src/client/**`, `src/server/database/**`, `src/styles/**`

## TODOs (priority order)

- [x] 1. Shared conversation-transaction seam. The pattern `database.transaction(() => { connect; ...work...; db.update(chatTable).set({ revision: sql`+1`, last_message_time })...; snapshot = readConversationSnapshot(db, id); if (!snapshot) throw new ConversationNotFoundError(id); return snapshot; }).immediate()` is hand-repeated in `commands/active-generation.ts` (5× revision bumps), `commands/commit-generation.ts:109-118` ≡ `commands/commit-sibling-variant.ts:143-152` (byte-identical), and `execute.ts`. Extract a helper (in `internal.ts` or new `commands/transaction.ts`) owning connect + revision bump (optional `last_message_time`) + snapshot read + not-found error. Use it in commit-generation.ts, commit-sibling-variant.ts, active-generation.ts. Also extract the duplicated terminal-data assembly (`[...(provenance ? [provenance] : []), ...(reasoning ? [{namespace:"generation",key:"reasoning",...}] : []), ...suppliedData]` + `messageVariantDataTable` insert) — verbatim at active-generation.ts:846-865 and :1191-1211.
- [x] 2. Dedupe the two accept functions. `acceptConversationTailGeneration` (:346-521) and `acceptConversationContinuationGeneration` (:528-657) share ~70% (revision guard, distinct-participants, control-pair authority, requireParticipant×2, captured-model-name check, existing-active check, `createProvisionalModelTarget`, `persistActiveGeneration`, revision bump + stale guard, snapshot). Extract the shared middle, parameterized by the differing validation (tail: human-message create/reuse; continuation: preceding-message). Keep ALL error messages and check ORDER identical — tests assert error precedence.
- [x] 3. Collapse triplicated server-owned generation scaffolding in `src/server/workflows/generate.ts`. Three identical interface pairs (`ServerOwnedSendGeneration`+Callbacks :152-164, `ServerOwnedContinuationGeneration`+Callbacks :974-983, `ServerOwnedSiblingGeneration`+Callbacks :1266-1275) and three `startServerOwned*` wrappers (:233-253, :1216-1236, :1481-1514). Reuse the existing generic `startServerOwnedGeneration` (:191-227); add ONE generic public wrapper + shared types; keep the three existing public function names as thin one-liners (grep repo incl. tests + src/shared/contract for usages before renaming).
- [x] 4. Unify the capture tail. Four `capture*Generation` functions build the same `{promptPlan, budget, historyRoles, humanParticipant, author, control, settings, connection, provenance}`. Extract one `toCapturedGeneration(derivation, settingsCapture, budget)`. IMPORTANT: the three `generationSettingsJson({...})` sites (:910-917 send/continue include `continuationPrefillSuffix`; :1437-1443 sibling omits it) — PRESERVE this asymmetry exactly; do not normalize.
- [x] 5. Split files still >~1000 lines into focused modules (generate-capture.ts, generate-server-owned.ts, or commands/accept-vs-lifecycle split), keeping the public barrel exports identical so no import site changes.

## Verification

- `bunx tsc --noEmit`
- `bun test src/server/workflows src/server/conversation` (behavior-preservation proof — fix the refactor, never the test, except mechanical import paths)
- `bun run lint`

## Commit

`git add -A && git commit -m "Extract shared generation/transaction seams; dedupe accept and capture paths"`

## Review (your ONE fanout — exactly once, after the commit)

Spawn the `code-reviewer` agent via the subagent tool with:

- Range: `31537ae..HEAD` in worktree `D:\Projects\DitzyTavern-wt\b-generation-seams`
- Spec: this ticket + handoff section "Fix 2 — generation-seams" + `D:\Projects\DitzyTavern\CODING_STANDARDS.md`
- Intent: zero behavior change; error precedence and the continuationPrefillSuffix asymmetry preserved; suite untouched (except mechanical import paths).

Fix blocking findings, re-verify, commit fixes.
