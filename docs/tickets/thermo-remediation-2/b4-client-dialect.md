# B4 — the one-liner dialect survives in client TSX, and no ceiling is enforced

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F11 (residue: the PR #45 server-only reformat left long lines in client TSX and no lint ceiling anywhere).

## Goal

One rule for line length and client TSX that obeys it: reformat every
`src/client/**/*.tsx` line over 200 characters that is code, and enforce the
ceiling with a warning-level oxlint rule so the dialect cannot regrow.

## Mechanics (all behavior-preserving)

- 41 client TSX files reformatted; every reformat keeps the same expressions,
  same order, same rendered JSX text. JSX whitespace rules were respected
  explicitly: line breaks are placed only where they cannot change text nodes
  (between adjacent expression containers, between element tags and the code
  around them, and inside expression bodies). Separator text nodes like
  ` · ` stay glued to their adjacent expressions so no space is swallowed or
  invented at a line break.
- One deliberate exception: `src/client/story/prose.tsx:86` builds an HTML
  button inside a template literal that flows into inline markdown (the
  prose renderer). Any newline inside that template changes the emitted
  HTML string, so the line stays 269 characters and is carried as the
  rule's one known warning in a scoped file.
- Three 200-character lines remain at the ceiling, exactly at the limit
  (`ParticipantMenu.tsx:38`, `MemoryIdentityDialog.tsx:55`,
  `MemorySettingsEditor.tsx:102`); the rule flags only lines over 200, and
  these are untouched code. `PromptPresetManagerDialog.tsx:99` is a long
  class-string attribute the rule reads as string-literal content.

## Enforcement decision

`anti-slop/no-overlong-code-lines`, warning severity, registered in
`oxlint.config.ts` alongside its siblings:

- Flags every source line whose length comes from code: a line is exempt
  when the uncovered characters (outside string, template, and JSX-text
  tokens and comments) form no run longer than a delimiter. That reads
  prompt-template bodies, long URL constants, and JSX prose as legitimate
  string content while catching any real code remnants, which always leave
  a longer run.
- Token-based, so the classifier is the same oxc parse the linting sees,
  not a heuristic string scan. Tests cover template interiors, string-only
  lines, JSX prose, comments, emoji (byte-vs-code-unit offsets), the
  custom `max` option, and the code remnants that must not exempt a line.

## Rules of engagement honored

- No `==[HUMAN APPROVED]==` marker touched; the name `status` avoided
  entirely so B3's parallel outcome rename stays clean.
- No logic moves, renames, or "improvements" beyond line breaking.

## Verification

`bun run check` (lint, lint:rules, check:contracts, typecheck,
typecheck:tools, unit tests, e2e harness) exits 0; `bun run test:e2e`
passes 36/36. Unit count: 1336 tests, 0 fail.

- `rg -n '.{200,}' src/client --glob '*.tsx' | rg -v test` → 5 lines, all
  listed above (1 documented exception + 3 at-ceiling + 1 string-attribute).
- File-size guard: largest reformat-grown TSX is `LorebookPanel.tsx` at
  849 lines; nothing approaches 1,000.
- Warning delta versus `c0b3fb6`: `no-overlong-code-lines` in
  `src/client` 186 → 14 (the 13 outside this ticket's `.ts` scope plus the
  documented prose exception); `no-unapproved-comments` unchanged at 20.
