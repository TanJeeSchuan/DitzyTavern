# T3: Stylesheets

Status: IN REVIEW

Blocked By: T2

Model: Opus 5.5 high. Reviewer: `codex gpt-6.1-sol high`.

Two moves with no visible change. Read `DESIGN.md` first. Evidence: report 22, F4 and F9.

## What to do

1. **Creator Mode out of `box-windows.css`.** The `.create-box*` rules (the second half of the file, 544 lines at review time) move to `src/styles/create-box.css`, imported where `box-windows.css` is. While moving, keep one copy of the monospace stack and of the prompt caret rule; the scout found each written twice. `box-windows.css` ends under 1000 lines.

2. **The New Chat form out of `responsive.css`.** The New Chat setup rules (130 lines with no media query) move to `src/styles/new-chat.css`. `responsive.css` keeps its responsive overrides and the global rules.

Import order decides which rule wins when specificity ties. Place each new import so the moved rules keep their position relative to the rules they override and the rules that override them.

## Verification

No component or snapshot tests (`AGENTS.md`). Compare screenshots with `playwright-cli` before and after, at 1440px and 390px, of: a Chat with a Box window open, Creator Mode with a session in progress, and the New Chat panel. Put the pairs in the PR body. Free ports 3000 and 5173 with `bun run dev:stop` when done; never stop a server you did not start.

## Rejected

- Replacing the New Chat form's `.seat-field` with `Field`: a visible change, not scheduled.
- Folding the responsive overrides into their owners' files: it moves lines and deletes none.
- A shared focus-ring token, a notice class, or any other consolidation from report 22.

## TODO

- [x] Move Creator Mode rules; drop the two duplicates
- [x] Move New Chat rules
- [x] Screenshot pairs at both widths
- [ ] PR

## Acceptance

`wc -l src/styles/box-windows.css` is under 1000. The screenshot pairs match.

## Outcome
