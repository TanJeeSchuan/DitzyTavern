# Repeatable Issue-Set Orchestration Prompt

Paste the **Master Instruction Block** into a fresh pi session at the repo root, replacing the
`<placeholders>`. It encodes everything learned running tickets 03–09 of `character-participant-system`
(worktree waves, in-lane self-review via fanout children, timeout incident, recovery lanes).

---

## Master Instruction Block

```
Implement the ticket set in .scratch/<system>/issues/ using the wave orchestration below.
Spec of record: .scratch/<system>/spec.md.

## 0. Read this first
- Ticket files (and the spec) are GITIGNORED. They exist only in the MAIN checkout. Worktree
  lanes never contain them — lanes must read/edit them via absolute main-checkout paths.
- The implementation pattern per ticket is the `implement` skill, and review happens INSIDE
  each lane: implementer (an explicit fanout child) spawns `code-reviewer` exactly once at the
  end; code-reviewer spawns its own two fresh axes (Standards ∥ Spec). The parent verifies the
  verdict — it never re-reviews.

## 1. Validate before launching anything
- [ ] Compute the wave plan: every ticket's "Blocked by" must be a resolved+merged ticket.
      Group into waves of ≤2 lanes; the critical path defines the wave count.
- [ ] Git tree is clean: `git status --porcelain` empty (worktree isolation hard-fails otherwise;
      untracked tooling dirs must be committed or gitignored).
- [ ] Agent `implementer` resolves as USER scope (C:\Users\<you>\.pi\agent\agents\implementer.md)
      — project scope is invisible to worktree children (worktrees live under os.tmpdir).
      Required frontmatter:
        model: <default impl model>
        thinking: high
        timeoutMs: 7200000        # 30-min package default kills large tickets (happened on W4)
        tools: read, grep, find, ls, bash, edit, write, todo, subagent
        skills: implement
- [ ] Agent `code-reviewer` resolves as USER scope with:
        model: <strong reviewer model, e.g. opencode-go/muse-spark-1.2-contributor>
        fallbackModels: <default model>   # in case the pinned model is not enabled
        tools: read, grep, find, ls, bash, subagent   # NO edit/write
        skills: code-review
      The pinned model must exist in the model store AND enabledModels (settings.json), else
      the child launch fails to resolve it.
- [ ] C:\Users\<you>\.pi\agent\extensions\subagent\config.json exists:
        { "maxSubagentDepth": 3 }
      Default is 2, which BLOCKS the code-reviewer's two axes (parent→implementer=1→
      code-reviewer=2→axes=3). The extension snapshots config at process start — after writing
      it, restart pi. Setx PI_SUBAGENT_MAX_DEPTH=3 is a belt-and-suspenders alternative.
- [ ] Verify: `subagent({action:"list"})` shows both as user agents;
      `subagent({action:"get", agent:"implementer"})` shows tools incl. subagent.

## 2. Wave loop (parent-owned)
For each wave (all blockers merged):
1. Launch ONE async workflowScript: `runs.all([...])` — one item per lane:
     { key: "t<N>", agent: "implementer", worktree: true,
       timeoutMs: 7_200_000,
       control: { needsAttentionAfterMs: 900_000, notifyOn: ["needs_attention"] },
       task: <lane task text, §3> }
   Arm `subagent_wait({ id, nonBlocking: true })` and return control.
2. On completion, pull each lane's handoff (output-archives JSON → handoffs path).
   The harness deletes lane branches after cleanup, but the commit SHAs survive in the
   object DB — recreate and merge in dependency order:
     git branch wN-tXX <sha>
     git merge wN-tXX --no-edit
   Expect conflicts where lanes touched the same module index (conversation/index.ts,
   workflows/index.ts, contract.ts) — merges are usually additive (keep both exports).
   If both lanes generated migrations: keep one, regenerate a clean one after merge.
3. Gates on MERGED state (not per-lane): bunx tsc --noEmit && bun run lint && bun test.
4. Verify evidence per ticket from the lane report: Status resolved, all TODOs ticked,
   review verdict (Standards ∥ Spec counts + worst finding). Accept; if a lane's verdict is
   thin or tests fail, send fixes back to that lane (resume/steer) — do not re-review.
5. Cleanup: git branch -D wN-tXX for each.

## 3. Per-lane task text (template)
Implement ticket <ABS main-checkout path to ticket .md> by running the implement skill
(loaded as your /skill:implement).
- Spec of record: <ABS main-checkout path to spec.md>
- Track progress in the ticket file per AGENTS.md: Status ready-for-agent → in_progress →
  resolved; tick TODOs incrementally as you implement, never one pass at the end. The ticket
  file is gitignored and absent from your worktree — edit it at the absolute path above.
- TDD at the pre-agreed seams: public module/workflow interfaces on a real migrated temp
  SQLite DB (follow existing src/**/*.test.ts patterns of that module).
- Run bunx tsc --noEmit regularly, bun test <affected file> frequently, and the full bun test
  suite once at the end. If you change seed data, update teardown.ts symmetrically (AGENTS.md).
- Your ONLY fanout (assigned): after the full suite passes, use the subagent tool exactly once
  to spawn the code-reviewer agent with your commit range. Fix what it flags, then commit.
  Do not spawn any other subagents.
- Commit to the lane branch and report: commit hash(es), files changed, TODOs ticked,
  test/lint/typecheck results, the review verdict (Standards ∥ Spec counts and worst finding),
  and any deviations.

## 4. Failure recovery
- Lane failed/timed out: the worktree is cleaned but a complete patch is preserved at the
  handoff's patch.path (worktree-diffs/<runId>/task-0-<agent>.patch). Launch a RECOVERY lane
  (same template) whose task STARTS with:
    git apply "<abs patch path>"   # from the worktree root
    git status   # verify the partial work is present
  then "continue from it — do not redo it."
- Attention events during the review fanout are EXPECTED (reviewer + two axes on a large diff
  legitimately takes minutes; the implementer appears idle while waiting on its subagent call).
  Liveness check: file-level status.json (per-step lastActivityAt + recentTools) or the lane
  session.jsonl mtime. Empty transcript views are NOT evidence of a stall.
- If a lane is genuinely stuck (>30 min no file activity): steer it with a targeted
  "finish and report" message; only interrupt as a last resort.

## 5. Acceptance criteria for the whole fleet
- Every ticket: Status resolved, 0 open TODOs (or a documented, in-ticket deferral).
- Merged branch: tsc clean, lint clean, full bun test green.
- No seed/teardown drift (lanes report "no seed changes" or touched both symmetrically).
- Only the integration branch (+ master) remains; all lane branches deleted.
```

---

## Lessons learned (why each rule exists)

| Rule | What bit us without it |
|---|---|
| `timeoutMs: 7200000` on implementer + per-run | W4 lanes t08/t09 died at the 30-min default mid-implementation (W1–W3 finished in 16–20 min and hid the limit) |
| User-scope agents, not project | Managed worktrees live in `os.tmpdir()`; project-scope `.pi/agents` is undiscoverable from the lane's cwd, so the implementer could not resolve `code-reviewer` for its fanout |
| `maxSubagentDepth: 3` | Default 2 blocks the code-reviewer from spawning its Standards/Spec axes (depth 3); config snapshots at extension start → restart pi after writing it |
| Pinned reviewer model in `enabledModels` | `muse-spark-1.2-contributor` exists in the store but wasn't enabled → child model resolution fails without it or `fallbackModels` |
| Clean tree gate | `?? .opencode/` / `?? .pi/` failed `git status --porcelain` → worktree isolation refuses to start. Fix: gitignore + one chore commit |
| Absolute ticket paths in lane text | `.scratch/` is gitignored → tickets/spec don't exist inside worktrees; lanes read/tick them at main-checkout absolute paths |
| Parent verifies verdict, never re-reviews | Implementer → code-reviewer → two axes is the sanctioned fanout chain (the implement skill mandates `/code-review`; parent-side review = third redundant review) |
| Recovery = `git apply` of the saved patch | The harness captures the full diff before worktree cleanup, so a timed-out lane's work is never lost; a continuation lane restores it, then finishes |
| Attention events ≠ stalls | `needsAttentionAfterMs` fires on long review fanouts; judge liveness by status.json `lastActivityAt` / session mtime, not transcript views |
| Merge order = dependency order | Keep the graph order even when traffic looks parallel; conflicts concentrate in module index re-export files and are additive |