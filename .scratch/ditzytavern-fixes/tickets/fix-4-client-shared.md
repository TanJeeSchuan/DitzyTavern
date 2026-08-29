# Fix 4 — Client shared seams + god files

Status: resolved
Worktree: D:\Projects\DitzyTavern-wt\d-client-shared
Branch: fix/4-client-shared
Base: 31537ae
Spec of record: D:\Projects\DitzyTavern\.scratch\handoff-ditzytavern-fixes.md → section "Fix 4 — client-shared"
Repo rules: D:\Projects\DitzyTavern\AGENTS.md · Context: D:\Projects\DitzyTavern\CONTEXT.md · Standards: D:\Projects\DitzyTavern\CODING_STANDARDS.md · UI: D:\Projects\DitzyTavern\DESIGN.md

## Objective

Delete client copy-paste and decompose the three worst client files. UI output identical. Style: small pure helper modules with colocated tests, `use`-prefixed hooks.

## Ownership (merge playbook — violating this causes merge conflicts)

- MAY touch: `src/client/workspace/**`, `src/client/cast/**` (hooks), panels (`CastPanel`, `CharacterLibraryPanel`, `NewChatPanel`, `GenerationPanel`, `ChatInformationPanel`, `GenerationDetailsPanel`, `ModelSelector`, `StoryMessageView`), `src/client/conversation.ts`, `character-library.ts`, `new-chat.ts`, `useConversationSession.ts`, `src/client/lib/**` (new use-async.ts, command-outcome.ts, format.ts), `src/client/import-chat/presentation.ts`, their tests
- MUST NOT touch: `chat-history.ts`, `import-chat.ts`, `import-chat-flow.ts`, `cast/definition.ts`, `character-library/definition.ts`, `workspace.ts`, `lib/sse.ts`, styles, server, shared

## TODOs

- [x] 1. Shared async-fetch hook `src/client/lib/use-async.ts`. The `cancelled`-flag useEffect pattern is copy-pasted 8× in 7 files: `ChatInformationPanel.tsx:49`, `GenerationDetailsPanel.tsx:33`, `NewChatPanel.tsx:209`, `ModelSelector.tsx:35`, `GenerationPanel.tsx:107+133`, `useConversationSession.ts:40+58`, `useConnectionSettingsController.ts:173`. Study all sites, pick the smallest interface, adopt everywhere. Preserve per-site error semantics (e.g. CastPanel swallows to empty list).
- [x] 2. Shared command-outcome mapper `src/client/lib/command-outcome.ts`. "The Conversation changed elsewhere…" / "The Conversation could not be reached." repeated ≥8 sites; `payload.outcome === "conflict" → "not-found" → "invalid" → { status: "network" }` rewritten 4× (`src/client/conversation.ts:83-92,109-120,140-148`, `character-library.ts:123-135`, `new-chat.ts:60-76`). Unify; verify wording is byte-identical first, keep majority wording if not.
- [x] 3. Decompose `src/client/workspace/GenerationPanel.tsx` (438 lines): extract `useGenerationSettingsDraft` hook (state + load + save + conflict recovery) following `useGenerationController.ts` pattern; component becomes presentation; JSX identical.
- [x] 4. Decompose `src/client/workspace/connection-settings/useConnectionSettingsController.ts` (443 lines): replace the 20-field `patch()` store (reducer is `return {...state, ...action.patch}` at :138-140) with focused state slices; extract ONE `runConnectionCommand` helper owning the repeated conflict/invalid/error ternary (:332, :360, :372, :395) so the 5 handlers (applyDraft, updateCredential, activateSelectedProfile, deletePendingProfile, resetCredential) collapse. Keep the returned ~26-member API shape IDENTICAL.
- [x] 5. Decompose `src/client/CastPanel.tsx` (432 lines): extract 4 handlers (applyRemove, applyAddCharacter, applyAddAdHoc, applySaveParticipant) into `src/client/cast/useCastActions.ts`, reusing cast-remove.ts/cast-save.ts + the new outcome mapper. Fix definition-order smell: applyRemove:104 calls `runCommand` declared at :148-160 — hoist it. Dialogs/notices identical.
- [x] 6. Adopt the shared hook in `CharacterLibraryPanel.tsx:55-67` and `NewChatPanel.tsx:208-221`.
- [x] 7. Dedupe formatters into `src/client/lib/format.ts`: `formatTimestamp` (story/StoryMessageView.tsx:16-25) ≡ `formatUpdatedAt` (workspace.ts:51-61); `formatSize` (ChatInformationPanel.tsx:26-32) vs `sourceSize` (import-chat/presentation.ts:3-9, differs only in null string — parameterize it).

## Verification

- `bunx tsc --noEmit`
- `bun test src/client`
- `bun run lint`
- re-check every moved JSX for dropped props

## Commit

`git add -A && git commit -m "Extract client shared async/outcome/format seams; decompose god components"`

## Review (your ONE fanout — exactly once, after the commit)

Spawn the `code-reviewer` agent via the subagent tool with:

- Range: `31537ae..HEAD` in worktree `D:\Projects\DitzyTavern-wt\d-client-shared`
- Spec: this ticket + handoff section "Fix 4 — client-shared" + `D:\Projects\DitzyTavern\CODING_STANDARDS.md`
- Intent: UI output identical; returned hook API shapes preserved; wording byte-identical or majority-kept.

Fix blocking findings, re-verify, commit fixes.
