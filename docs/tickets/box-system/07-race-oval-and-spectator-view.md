# Race oval and spectator view

Status: TODO

Blocked By: 06-race-engine-in-the-prompt

Source: `docs/box-system/spec.md`, User Story 30; Implementation Decisions "Race Box" (window); DESIGN.md.

## Goal

While a race runs, the Race window shows a 2D SVG oval with each Runner's marker, the gaps between them, and the finish post. It shows only what a spectator could see.

## Ownership

- Race window visuals

## Work

- [ ] Replace the text standings with an SVG oval laid out for the course's direction and distance, with Runner markers, gaps and the finish post.
- [ ] Show Runner names and avatar placeholders. Avatars arrive in tickets 09 and 10.
- [ ] Show positions and gaps only. No stamina, decisions or intents while running.
- [ ] Animate markers between Stretches when the selected Variant changes.
- [ ] Verify manually with playwright-cli at window size and narrow layout. No UI tests.
- [ ] Run `bun run check`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The oval matches the folded state of the selected Variant, including after re-selecting an earlier Variant.
