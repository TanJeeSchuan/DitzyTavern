# Fix 5 — Dead code purge

Status: resolved
Worktree: D:\Projects\DitzyTavern-wt\e-dead-code
Branch: fix/5-dead-code
Base: 31537ae
Spec of record: D:\Projects\DitzyTavern\.scratch\handoff-ditzytavern-fixes.md → section "Fix 5 — dead-code"
Repo rules: D:\Projects\DitzyTavern\AGENTS.md · Context: D:\Projects\DitzyTavern\CONTEXT.md · Standards: D:\Projects\DitzyTavern\CODING_STANDARDS.md

## Objective

Delete dead code with verification for every deletion. Nothing behavioral changes.

## Ownership (merge playbook — violating this causes merge conflicts)

- MAY touch: `src/styles/workspace.css` (delete dup `.connection-*` block), `story.css`, `responsive.css`, `cast.css`, `import-chat.css` (dead classes only), DELETE `src/client/lib/sse.ts`, `src/client/workspace.ts` (dead types), `src/server/model-client/test-connection.ts` + test
- MUST NOT touch: `theme.css`, `connection-settings.css`, any `.tsx`, `chat-history.ts`, `import-chat.ts`, `src/server/conversation/**`, `src/server/workflows/**`, `deepseek.ts`

## TODOs

- [x] 1. CSS: remove the ~180-line byte-duplicated `.connection-*` block from `src/styles/workspace.css` (~:719-900+; 50 selectors byte-identical to `connection-settings.css`; counts: 54 `.connection-` matches in workspace.css vs 79 there). Diff each rule; delete ONLY byte-identical (modulo whitespace) ones; list any kept. Eyeball brace balance after.
  - VERDICT: actual block was lines 719-1046 (328 lines, 54 `.connection-` matches incl. 4 `.credential-*` selectors). `diff` of workspace.css 719-1046 vs connection-settings.css 137-464: BYTE-IDENTICAL. Deleted 719-1047; kept: none. Braces balanced 99:99; both files globally imported in `src/index.css`.
  - STEM VERDICTS (all: zero ts/tsx className refs, incl. stems + dynamic-interpolation check — only 2 className template literals exist, neither builds any candidate): `.identity-menu` story.css+responsive.css → DELETED; `.identity-button` story.css+responsive.css → DELETED; `.identity-picker` story.css → DELETED; `.portrait-stack` story.css → DELETED (kept the inert `:not(.portrait-stack)` exclusion inside the LIVE `.cast-control` rule, responsive.css:244 — removing it is behaviorally identical but live rules stay untouched); `.chapter-opening` story.css+responsive.css → DELETED; `.copy-confirmation` story.css standalone + comma-group member + responsive.css → DELETED; `.more-menu-wrap` story.css → DELETED; `.message-menu` story.css → DELETED; `.empty-chat-cast` story.css → DELETED (live `.empty-chat` in StoryStatus.tsx is a different class); `.generated-message` story.css 2 comma-groups + responsive.css → DELETED (live `.story-message` kept); `.cast-panel-body` workspace.css + responsive.css comma-group → DELETED; `.cast-placeholder` responsive.css (+ section comment) → DELETED; `.prompt-inspection` story.css + workspace.css comma-group → DELETED (compiler.ts:12 hit is prose in a comment, not a class); `.import-suggest-tag` import-chat.css → DELETED (live `.import-suggestion` is different); `.connection-active-note` workspace.css copy removed via TODO 1; connection-settings.css copies (246/452/462) RETAINED — ownership forbids touching that file. Final brace counts after all deletions: workspace 98:98 (was 99:99 at TODO-1 completion, before TODO-2 removed the dead `.cast-panel-body` block), story 108:108, responsive 92:92, import-chat 124:124. Extra observation: `.writer-message` (story.css) also has zero className refs (only `id="writer-message"` in Composer.tsx) but is NOT a ticket candidate → left untouched.
- [x] 2. Delete dead CSS class families — audit candidates: `.identity-menu`, `.identity-button`, `.identity-picker`, `.portrait-stack`, `.chapter-opening`, `.copy-confirmation`, `.more-menu-wrap`, `.message-menu`, `.empty-chat-cast`, `.generated-message`, `.cast-panel-body`, `.cast-placeholder`, `.prompt-inspection`, `.import-suggest-tag`, `.connection-active-note`. For EACH: grep whole `src/` including stems and dynamic className interpolation before deleting the block + its dependents. List every stem + verdict. NEVER touch `theme.css` (`.dark` is shadcn's hook).
- [x] 3. Delete `src/client/lib/sse.ts` (verified zero imports — re-verify, then delete).
- [x] 4. Delete dead legacy types in `src/client/workspace.ts:5-45`: `Swipe`, `WriterMessage`, `GeneratedMessage`, `StoryMessage` (NOT the live `StoryMessage` in `src/client/story.ts`), and `Workspace.messages` field only if unreferenced (grep `.messages` reads). Same rule for other Swipe-era remnants in the file.
- [x] 5. Delete `testDeepSeekConnection` alias (`src/server/model-client/test-connection.ts:148`): if only its test uses it, update test to `testConnection` and delete; if production uses it, skip and report.

## Verification

- `bunx tsc --noEmit`
- `bun test src/client src/server/model-client`
- `bun run lint`
- `bun run build` (catches broken CSS imports)

## Commit

`git add -A && git commit -m "Delete dead CSS blocks, legacy types, and obsolete aliases"`

## Review (your ONE fanout — exactly once, after the commit)

Spawn the `code-reviewer` agent via the subagent tool with:

- Range: `31537ae..HEAD` in worktree `D:\Projects\DitzyTavern-wt\e-dead-code`
- Spec: this ticket + handoff section "Fix 5 — dead-code" + `D:\Projects\DitzyTavern\CODING_STANDARDS.md`
- Intent: deletions only, each with per-stem verdict evidence; zero behavioral change.

Fix blocking findings, re-verify, commit fixes.
