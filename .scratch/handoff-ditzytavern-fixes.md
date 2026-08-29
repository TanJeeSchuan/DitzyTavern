# Handoff — DitzyTavern thermo-nuclear fix execution

Date: 2026-08-29
Repo: `D:\Projects\DitzyTavern` (branch `master`, HEAD `31537ae` "Reconcile generation provenance contract")
Temp worktree root: `D:\Projects\DitzyTavern-wt`

## Mission

Execute the 6 fixes from a completed thermo-nuclear code-quality audit of DitzyTavern, each in its own git worktree via a subagent, then merge all 6 branches back into `master`, resolving conflicts via subagents. **No implementation has happened yet** — two batches of 6+3 parallel subagent launches were cancelled by the environment before any agent started. Everything below is ready to relaunch.

## Done so far

1. **Audit complete.** Findings were delivered in-conversation (not persisted in the repo). Top-level verdict: median files are well-factored, but 8 structural problems exist. The 6 actionable fixes are enumerated below with full task briefs.
2. **6 worktrees created** from `31537ae`, one branch per fix, zero commits:

| Worktree | Branch | Fix |
|---|---|---|
| `D:\Projects\DitzyTavern-wt\a-contract-types` | `fix/1-contract-types` | Derive client types from contract |
| `D:\Projects\DitzyTavern-wt\b-generation-seams` | `fix/2-generation-seams` | Shared transaction + generation seams |
| `D:\Projects\DitzyTavern-wt\c-cheap-reads` | `fix/3-cheap-reads` | conversationExists cheap reads |
| `D:\Projects\DitzyTavern-wt\d-client-shared` | `fix/4-client-shared` | Client shared seams + god files |
| `D:\Projects\DitzyTavern-wt\e-dead-code` | `fix/5-dead-code` | Dead code purge |
| `D:\Projects\DitzyTavern-wt\f-migration-squash` | `fix/6-migration-squash` | Migrations squash |

3. Main worktree has one **uncommitted `.gitignore` edit** — leave it alone; do not commit or stash it as part of the fixes.

## Key facts about the codebase

- Bun + Elysia + Drizzle (bun-sqlite) server, React 19 + vite client, TypeBox contracts via Elysia + Eden treaty client.
- ~330 source files. Biggest production files: `src/server/workflows/generate.ts` (1,496), `src/server/conversation/commands/active-generation.ts` (1,289), `src/shared/contract/conversation.ts` (774), `src/server/conversation/types.ts` (726), `src/client/import-chat-flow.ts` (709).
- Commands: `bun install` (needed in each worktree first), `bun test <path>` (colocated `*.test.ts`), `bun run lint` (oxlint), `bunx tsc --noEmit`, `bun run build` (vite), `bun run db:generate` / `db:seed` / `db:teardown`.
- Read `AGENTS.md` (repo rules: seed/teardown pairing, ticket hygiene), `CONTEXT.md` (domain vocabulary: Generation, Send, Continue, Sibling, Provisional Variant, Selected narrative path — naming matters), `DESIGN.md` for UI work, `CODING_STANDARDS.md`.
- No `any` in production code; casts carry `SAFETY:` comments. Follow existing file style; comments are used liberally but only for non-obvious decisions.
- Never commit secrets (`.env` exists at repo root).

## Subagent execution plan

- **Batch 1 (parallel):** fixes 1 (contract types), 3 (cheap reads), 5 (dead code) — most independent.
- **Batch 2 (parallel, after batch 1 or independent):** fixes 2 (generation seams), 4 (client shared), 6 (migrations squash).
- Historical note: batches of 6 and of 3 were both cancelled by the environment. If launches keep getting cancelled, fall back to sequential one-at-a-time execution.
- Each agent: work only in its worktree, `bun install` first, verify (tsc + targeted `bun test` + `bun run lint`, plus `bun run build` for CSS-touching fix 5), then `git add -A && git commit` with the message given in its brief.
- **Merge order after all 6 complete:** 3 (cheap-reads) → 2 (generation-seams) → 1 (contract-types) → 4 (client-shared) → 5 (dead-code) → 6 (migration-squash). Merge into `master` in the main worktree with `git merge --no-ff fix/N-...`. On conflict, resolve via a general subagent (give it the conflict paths, both branches' intents, and the ownership map below; require tests + lint after resolution). Do not push.

## File-ownership map (prevents conflicts; give to every agent + conflict resolver)

| Agent | May touch | Must NOT touch |
|---|---|---|
| 1 contract-types | `src/client/chat-history.ts`, `src/client/import-chat.ts`, `src/client/import-chat-flow.ts`, `src/client/cast/definition.ts`, `src/client/character-library/definition.ts`, `src/shared/**` (additive), new `src/client/lib/json-guards.ts`, their `.test.ts` | any `.tsx`, `src/client/conversation.ts`, `src/client/character-library.ts`, `src/client/new-chat.ts`, `src/client/workspace.ts`, `src/client/lib/sse.ts`, `src/styles/**`, `src/server/**` |
| 2 generation-seams | `src/server/workflows/**`, `src/server/conversation/**` (commands/, internal.ts, types.ts, index.ts re-exports), their `.test.ts` | `src/server/conversation/snapshot.ts`, `src/server/conversation/index.ts` getGenerationSettings body, `src/shared/**`, `src/client/**`, `src/server/database/**`, `src/styles/**` |
| 3 cheap-reads | `src/server/conversation/index.ts`, `src/server/conversation/snapshot.ts`, their `.test.ts` | `internal.ts`, `commands/**`, `types.ts`, workflows, shared, client, database |
| 4 client-shared | `src/client/workspace/**`, `src/client/cast/**` (hooks), panels (`CastPanel`, `CharacterLibraryPanel`, `NewChatPanel`, `GenerationPanel`, `ChatInformationPanel`, `GenerationDetailsPanel`, `ModelSelector`, `StoryMessageView`), `src/client/conversation.ts`, `character-library.ts`, `new-chat.ts`, `useConversationSession.ts`, `src/client/lib/**` (new use-async.ts, command-outcome.ts, format.ts), `src/client/import-chat/presentation.ts`, their tests | `chat-history.ts`, `import-chat.ts`, `import-chat-flow.ts`, `cast/definition.ts`, `character-library/definition.ts`, `workspace.ts`, `lib/sse.ts`, styles, server, shared |
| 5 dead-code | `src/styles/workspace.css` (delete dup `.connection-*` block), `story.css`, `responsive.css`, `cast.css`, `import-chat.css` (dead classes only), delete `src/client/lib/sse.ts`, `src/client/workspace.ts` (dead types), `src/server/model-client/test-connection.ts` + test | `theme.css`, `connection-settings.css`, any `.tsx`, `chat-history.ts`, `import-chat.ts`, `src/server/conversation/**`, `src/server/workflows/**`, `deepseek.ts` |
| 6 migration-squash | `src/server/database/migrations/**`, `seed.ts` (only if folding backfill), `drizzle.config.ts` (if needed) | `schema.ts`, conversation, workflows, shared, client, styles |

## Fix briefs (verbatim task specs for the agents)

### Fix 1 — contract-types (`fix/1-contract-types`)

GOAL — collapse the client's hand-duplicated type layer by deriving it from the shared contract, and fix two known behavioral drifts:

1. **Derive client payload types from TypeBox contract schemas.** `src/client/chat-history.ts` and `src/client/import-chat.ts` re-declare server payload shapes as parallel local interfaces (e.g. `ChatImportDuplicateMatch`, `ChatImportPreview`, receipt shapes) and hand-validate JSON. Real schemas exist as TypeBox (`t.Object`) in `src/shared/contract/chat-import.ts` and `src/shared/contract/conversation-schema.ts`. Add named `Static<typeof ...>` exports to the schema files where needed, then make the client modules import those types instead of declaring their own. Keep the hand-rolled runtime validation functions exactly as they are (deliberate transport seam) — types only. If a client interface has no contract counterpart, leave it and note it. No runtime behavior/URL/validation changes.
2. **Dedupe the two known drifts:**
   - `UNKNOWN_IMPORTED_AUTHOR_NAME` duplicated in `src/server/sillytavern/import-projection.ts:38` and `src/client/import-chat-flow.ts:30`. Put it in a tiny shared module under `src/shared/` (style: see `src/shared/cast.ts`, `src/shared/generation-overrides.ts`) and import from both sides.
   - `openingsFromText` duplicated with divergent behavior: `src/client/cast/definition.ts:26-27` trims lines, `src/client/character-library/definition.ts:29` does not. Extract ONE shared function (keep the trimming variant) into `src/client/lib/` and import from both. If a test fails only on whitespace, adjust the shared function to preserve tests; otherwise report.
3. Optional if trivial: dedupe the byte-identical JSON guards (`isRow/isString/isNumber/isBoolean/isStringArray`, import-chat.ts:149-164 ≡ chat-history.ts:153-168) into `src/client/lib/json-guards.ts`. Defer if risky; items 1–2 are the priority.

VERIFY: `bunx tsc --noEmit`; `bun test` for import-chat-flow/import-chat/chat-history tests; `bun run lint`; grep that nothing imports deleted local interfaces.
COMMIT: `git add -A && git commit -m "Derive client import/history types from shared contract schemas"`

### Fix 2 — generation-seams (`fix/2-generation-seams`)

GOAL — pure structural refactor, zero behavior change, verified by the existing suite (`src/server/workflows/generate.test.ts`, `src/server/conversation/*.test.ts`). Read CONTEXT.md first; naming matters. Priority order:

1. **Shared conversation-transaction seam.** The pattern `database.transaction(() => { connect; ...work...; db.update(chatTable).set({ revision: sql\`+1\`, last_message_time })...; snapshot = readConversationSnapshot(db, id); if (!snapshot) throw new ConversationNotFoundError(id); return snapshot; }).immediate()` is hand-repeated in `commands/active-generation.ts` (5× revision bumps), `commands/commit-generation.ts:109-118` ≡ `commands/commit-sibling-variant.ts:143-152` (byte-identical), and `execute.ts`. Extract a helper (in `internal.ts` or new `commands/transaction.ts`) owning connect + revision bump (optional `last_message_time`) + snapshot read + not-found error. Use it in commit-generation.ts, commit-sibling-variant.ts, active-generation.ts. Also extract the duplicated terminal-data assembly (`[...(provenance ? [provenance] : []), ...(reasoning ? [{namespace:"generation",key:"reasoning",...}] : []), ...suppliedData]` + `messageVariantDataTable` insert) — verbatim at active-generation.ts:846-865 and :1191-1211.
2. **Dedupe the two accept functions.** `acceptConversationTailGeneration` (:346-521) and `acceptConversationContinuationGeneration` (:528-657) share ~70% (revision guard, distinct-participants, control-pair authority, requireParticipant×2, captured-model-name check, existing-active check, `createProvisionalModelTarget`, `persistActiveGeneration`, revision bump + stale guard, snapshot). Extract the shared middle, parameterized by the differing validation (tail: human-message create/reuse; continuation: preceding-message). Keep ALL error messages and check ORDER identical — tests assert error precedence.
3. **Collapse triplicated server-owned generation scaffolding in `src/server/workflows/generate.ts`.** Three identical interface pairs (`ServerOwnedSendGeneration`+Callbacks :152-164, `ServerOwnedContinuationGeneration`+Callbacks :974-983, `ServerOwnedSiblingGeneration`+Callbacks :1266-1275) and three `startServerOwned*` wrappers (:233-253, :1216-1236, :1481-1514). Reuse the existing generic `startServerOwnedGeneration` (:191-227); add ONE generic public wrapper + shared types; keep the three existing public function names as thin one-liners (grep repo incl. tests + src/shared/contract for usages before renaming).
4. **Unify the capture tail.** Four `capture*Generation` functions build the same `{promptPlan, budget, historyRoles, humanParticipant, author, control, settings, connection, provenance}`. Extract one `toCapturedGeneration(derivation, settingsCapture, budget)`. IMPORTANT: the three `generationSettingsJson({...})` sites (:910-917 send/continue include `continuationPrefillSuffix`; :1437-1443 sibling omits it) — PRESERVE this asymmetry exactly; do not normalize.
5. **Split files still >~1000 lines** into focused modules (generate-capture.ts, generate-server-owned.ts, or commands/accept-vs-lifecycle split), keeping the public barrel exports identical so no import site changes.

VERIFY: `bunx tsc --noEmit`; `bun test src/server/workflows src/server/conversation` (behavior-preservation proof — fix the refactor, never the test, except mechanical import paths); `bun run lint`.
COMMIT: `git add -A && git commit -m "Extract shared generation/transaction seams; dedupe accept and capture paths"`

### Fix 3 — cheap-reads (`fix/3-cheap-reads`)

PROBLEM: `src/server/conversation/index.ts:145-155` `getGenerationSettings` runs the full 8-query snapshot read (~260 lines in snapshot.ts) purely as an existence check, discards it, then builds a second `connectConversationDatabase` for `readConversationGenerationSettings`.

TASKS:
1. Add cheap `conversationExists(db, conversationId)` (single-row chatTable select) in `src/server/conversation/snapshot.ts` (NOT internal.ts — owned by fix 2) and export it.
2. Rewrite `getGenerationSettings` in index.ts: ONE `connectConversationDatabase` instance; `conversationExists` for the undefined path; then `readConversationGenerationSettings` with the same instance. Preserve exact return semantics (check generation-settings.ts; tests confirm).
3. Grep for other full-snapshot-as-existence-check sites in src/server/conversation + workflows; fix any found. Known non-candidate to leave alone but report: `src/server/connection-settings/index.ts:371-386` requireRevision (second module instance for error state — out of scope).

VERIFY: `bunx tsc --noEmit`; `bun test src/server/conversation src/server/workflows src/server/connection-settings`; `bun run lint`.
COMMIT: `git add -A && git commit -m "Replace full-snapshot existence check with cheap conversationExists"`

### Fix 4 — client-shared (`fix/4-client-shared`)

GOAL — delete client copy-paste and decompose the three worst client files. UI output identical. Style: small pure helper modules with colocated tests, `use`-prefixed hooks.

1. **Shared async-fetch hook** `src/client/lib/use-async.ts`. The `cancelled`-flag useEffect pattern is copy-pasted 8× in 7 files: `ChatInformationPanel.tsx:49`, `GenerationDetailsPanel.tsx:33`, `NewChatPanel.tsx:209`, `ModelSelector.tsx:35`, `GenerationPanel.tsx:107+133`, `useConversationSession.ts:40+58`, `useConnectionSettingsController.ts:173`. Study all sites, pick the smallest interface, adopt everywhere. Preserve per-site error semantics (e.g. CastPanel swallows to empty list).
2. **Shared command-outcome mapper** `src/client/lib/command-outcome.ts`. "The Conversation changed elsewhere…" / "The Conversation could not be reached." repeated ≥8 sites; `payload.outcome === "conflict" → "not-found" → "invalid" → { status: "network" }` rewritten 4× (`src/client/conversation.ts:83-92,109-120,140-148`, `character-library.ts:123-135`, `new-chat.ts:60-76`). Unify; verify wording is byte-identical first, keep majority wording if not.
3. **Decompose `src/client/workspace/GenerationPanel.tsx` (438 lines)**: extract `useGenerationSettingsDraft` hook (state + load + save + conflict recovery) following `useGenerationController.ts` pattern; component becomes presentation; JSX identical.
4. **Decompose `src/client/workspace/connection-settings/useConnectionSettingsController.ts` (443 lines)**: replace the 20-field `patch()` store (reducer is `return {...state, ...action.patch}` at :138-140) with focused state slices; extract ONE `runConnectionCommand` helper owning the repeated conflict/invalid/error ternary (:332, :360, :372, :395) so the 5 handlers (applyDraft, updateCredential, activateSelectedProfile, deletePendingProfile, resetCredential) collapse. Keep the returned ~26-member API shape IDENTICAL.
5. **Decompose `src/client/CastPanel.tsx` (432 lines)**: extract 4 handlers (applyRemove, applyAddCharacter, applyAddAdHoc, applySaveParticipant) into `src/client/cast/useCastActions.ts`, reusing cast-remove.ts/cast-save.ts + the new outcome mapper. Fix definition-order smell: applyRemove:104 calls `runCommand` declared at :148-160 — hoist it. Dialogs/notices identical.
6. Adopt the shared hook in `CharacterLibraryPanel.tsx:55-67` and `NewChatPanel.tsx:208-221`.
7. **Dedupe formatters** into `src/client/lib/format.ts`: `formatTimestamp` (story/StoryMessageView.tsx:16-25) ≡ `formatUpdatedAt` (workspace.ts:51-61); `formatSize` (ChatInformationPanel.tsx:26-32) vs `sourceSize` (import-chat/presentation.ts:3-9, differs only in null string — parameterize it).

VERIFY: `bunx tsc --noEmit`; `bun test src/client`; `bun run lint`; re-check every moved JSX for dropped props.
COMMIT: `git add -A && git commit -m "Extract client shared async/outcome/format seams; decompose god components"`

### Fix 5 — dead-code (`fix/5-dead-code`)

GOAL — delete dead code with verification for every deletion. Nothing behavioral changes.

1. **CSS: remove the ~180-line byte-duplicated `.connection-*` block from `src/styles/workspace.css`** (~:719-900+; 50 selectors byte-identical to `connection-settings.css`; counts: 54 `.connection-` matches in workspace.css vs 79 there). Diff each rule; delete ONLY byte-identical (modulo whitespace) ones; list any kept. Eyeball brace balance after.
2. **Delete dead CSS class families** — audit candidates: `.identity-menu`, `.identity-button`, `.identity-picker`, `.portrait-stack`, `.chapter-opening`, `.copy-confirmation`, `.more-menu-wrap`, `.message-menu`, `.empty-chat-cast`, `.generated-message`, `.cast-panel-body`, `.cast-placeholder`, `.prompt-inspection`, `.import-suggest-tag`, `.connection-active-note`. For EACH: grep whole `src/` incl. stems and dynamic className interpolation before deleting the block + its dependents. List every stem + verdict. NEVER touch `theme.css` (`.dark` is shadcn's hook).
3. **Delete `src/client/lib/sse.ts`** (verified zero imports — re-verify, then delete).
4. **Delete dead legacy types in `src/client/workspace.ts:5-45`**: `Swipe`, `WriterMessage`, `GeneratedMessage`, `StoryMessage` (NOT the live `StoryMessage` in `src/client/story.ts`), and `Workspace.messages` field only if unreferenced (grep `.messages` reads). Same rule for other Swipe-era remnants in the file.
5. **Delete `testDeepSeekConnection` alias** (`src/server/model-client/test-connection.ts:148`): if only its test uses it, update test to `testConnection` and delete; if production uses it, skip and report.

VERIFY: `bunx tsc --noEmit`; `bun test src/client src/server/model-client`; `bun run lint`; `bun run build` (catches broken CSS imports).
COMMIT: `git add -A && git commit -m "Delete dead CSS blocks, legacy types, and obsolete aliases"`

### Fix 6 — migration-squash (`fix/6-migration-squash`)

GOAL — squash migration history to a single baseline from current `src/server/database/schema.ts`.

CONTEXT: `src/server/database/migrations/` = 21 SQL + 20 meta snapshots (~500 KB; 0000=1.2KB → 0020=56KB). Dev environment; AGENTS.md says clearing data is cheap. `database.ts:28-31` runs `migrate()` on every `openDatabase()`. One hand-written data migration: `0013_backfill_generation_settings.sql` (journal version "7").

STEPS:
1. Read `drizzle.config.ts`, `database.ts`, journal.
2. Decide the backfill's fate: fold into `seed.ts` only if seed-shaped; if it backfills arbitrary user data, keep it as a hand-written second migration (`0001_backfill_generation_settings.sql` + journal entry) after the baseline. Explain the choice. Conservative default: keep as tiny second migration.
3. Delete `migrations/` entirely; `bun run db:generate` → single fresh `0000_*.sql` + journal + one snapshot; spot-check tables incl. active_generation and generation_replay.
4. Prove fresh migrate works: `bun test src/server` (opens databases everywhere).
5. `bun run db:seed` then `bun run db:teardown` on the dev DB.
6. Update any filename/journal references if they exist.

VERIFY: `bun test src/server`; `bunx tsc --noEmit`; generated SQL covers all schema.ts tables; `bun run lint`.
COMMIT: `git add -A && git commit -m "Squash migration history to single baseline"`

## Merge & conflict-resolution playbook (after all 6 agents finish)

1. In the main worktree (`D:\Projects\DitzyTavern`, branch `master`): merge in order 3 → 2 → 1 → 4 → 5 → 6 with `git merge --no-ff fix/N-...`.
2. On conflict: dispatch a general subagent per conflict batch with: the conflicted file list, the intent of BOTH branches (from the ownership map + briefs above), and instruction to resolve preserving BOTH behaviors, then run `bunx tsc --noEmit` + targeted `bun test` + `bun run lint` before `git add` + `git commit` of the merge. Highest-risk conflict zones: `src/server/conversation/index.ts` (fixes 2+3), `src/client/lib/*` (fixes 1+4 creating different files), `src/client/CastPanel.tsx` imports (fixes 4+5 indirectly), `workspace.css` (fix 5) vs nothing else.
3. After all merges: full `bun test`, `bunx tsc --noEmit`, `bun run lint`, `bun run build`. Do NOT push. Leave the uncommitted `.gitignore` edit untouched.
4. Clean up worktrees afterwards if desired: `git worktree remove D:\Projects\DitzyTavern-wt\<name>` per worktree (after merges).

## Suggested skills for the next agent

- `thermo-nuclear-code-quality-review` — the standard this work was derived from; re-check after merging if asked.
- `implement` — if executing the briefs ticket-by-ticket instead of direct subagent dispatch.
- `tdd` — not required (behavior-preserving refactor; the existing suite is the safety net), but useful if a fix needs a characterization test first.
- `code-review` — worth running over `master..fix/N` diffs before merging if time allows.

## Environment notes

- Windows, pwsh 7. Use `workdir` parameter for bash tool calls; quote paths. `bun`, `git`, `rg` available. `playwright-cli` installed (not needed for this work).
- Subagent launches: both a 6-parallel batch and a 3-parallel batch were cancelled by the environment ("Task cancelled" immediately). If it recurs, run agents strictly one at a time.
