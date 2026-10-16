# Play a Race with Moves

Status: DONE

Blocked By: 06-race-engine-in-the-prompt

Source: `docs/box-system/README.md` "`moves` and `moves.render`", "Move staging", "Worked example: the Race" (Moves); GLOSSARY "Move"; ADR-0050.

## Goal

The writer's Runner is in the race, so the Race window offers legal Moves with their cost and odds. The writer stages ⚡Overtake and ⏳Conserve as chips in the composer, reorders them, adds a line or sends no text at all, and the next Stretch resolves them in order. Swiping that turn replays the same Moves.

## Ownership

- Moves on Human-authored Messages
- Composer Move chips
- Race Moves

## Work

- [x] Add `moves` (`schema`, `render`) to the contract.
- [x] Store ordered Moves on the Human-authored Message in `messages_data`. A Message may consist of Moves alone.
- [x] Composer chips: staged from a Box window, shown above the text, reorderable by drag, removable.
- [x] Story view shows a Message's Moves as chips. History sent to the model replaces each Move with `render`.
- [x] Editing a Message's Moves and regenerating replays the turn. A Sibling reuses its Message's Moves.
- [x] Race Moves for the human-seat Runner, or orders to a chosen Runner when the human seat is not racing. Offer only legal Moves, validated against costs projected from earlier staged Moves. `Hold` skips the Stretch. A Move may fizzle and is narrated. Moves are disabled in Auto mode and in `until` until the set distance.
- [x] The advance item reports what each Move achieved.
- [x] E2E: a Moves-only turn, Moves with text, a fizzle, a swipe reusing Moves.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- A Moves-only Message is a Human-authored Message, not a Continuation.
- The model sees each Move's intent in history and its outcome only in its own Stretch's item.
