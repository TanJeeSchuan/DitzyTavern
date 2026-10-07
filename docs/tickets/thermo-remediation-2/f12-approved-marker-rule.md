# `==[HUMAN APPROVED]==` has become the dominant token

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F12.

## Goal

The lint rule `anti-slop(no-unapproved-comments)` required every comment to carry the inline
`==[HUMAN APPROVED]==` marker. The marker now obscures the comment it approves and every doc
block opens with the same twenty characters. After this ticket the rule accepts a second
spelling of the same approval mechanism — a leading `// @approved` directive line — while the
inline marker stays valid, so the 1,148 existing markers (at the review's baseline master)
remain accepted and nothing in `src/` breaks. The mass conversion of markers to the directive
form is deferred to the final cleanup wave, after all structural PRs merge: converting now
would collide with six open remediation branches.

## Ownership

- `tools/oxlint/anti-slop/rules/no-unapproved-comments.ts`
- `tools/oxlint/anti-slop/rules/no-unapproved-comments.test.ts`
- `scripts/audit-comments.ts`

## Mechanics

- The rule's standalone-block approval check is extended by one predicate:
  `value.trim() === "@approved"`, OR'd into the existing
  `block.some(approved || ignored)` check. The directive must be the block's first line, so
  it immediately precedes the comment it approves; a blank line or code between the
  directive and the comment leaves the comment unapproved.
- One mechanism, two spellings — no second rule, no new option, no extra comment pass. The
  directive spelling is fixed and independent of the `marker` option.
- The directive never reaches a trailing comment or a block comment: `@approved` above code
  approves nothing (the trailing comment on the next line still needs the inline marker),
  and a block comment still carries the marker inside it.
- The rule's unapproved-comment message now names both spellings, and the
  `audit:comments` hint line does the same; the audit script otherwise stays
  marker-agnostic (it aggregates the rule's oxlint diagnostics).
- Nothing in `src/` was converted — `git diff <baseline> -- src` is empty.

## Verification

- `bun run lint:rules` — 59 tests pass (50 before; 9 new directive cases).
- `bun run lint` — exit 0; warning counts identical with and without the change
  (39 warnings, 35 `no-unapproved-comments`), so zero new warnings.
- `bun run typecheck`, `bun run typecheck:tools` — exit 0.
- `bun run audit:comments` — runs and prints the dual-spelling hint.
- `rg -c 'HUMAN APPROVED' src` count unchanged by this change (src has no diff against its
  baseline commit).
- Longest file in `src/` remains under 1,000 lines.

## Acceptance

- Existing inline markers keep passing; unapproved comments still warn.
- A leading `// @approved` line immediately above a standalone comment block passes; a gap,
  a mid-block directive, a directive above code or a block comment, and a non-exact
  directive line all still warn.
- No conversions in `src/` — the mass conversion lands in the final cleanup wave.
