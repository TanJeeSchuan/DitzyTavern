# Race drama and replay

Status: DONE

Blocked By: 06-race-engine-in-the-prompt

Source: `docs/box-system/spec.md`, User Stories 29–30; Implementation Decisions "Race Box" (advance item, library data, window); GLOSSARY "Hidden intent".

## Goal

Gold Ship breaks last on purpose. The narrator is told to foreshadow it without revealing it, and when she charges in the final Stretch the item says "Reveal now: the late start was planned." After the finish, the Race window replays every Runner's decisions Stretch by Stretch. Roster Runners show their avatars.

## Ownership

- Race Hidden intents and salience
- Race replay
- Roster avatars

## Work

- [x] The engine records each Runner's decisions per Stretch and pairs a Hidden intent with its payoff Stretch.
- [x] The advance item foreshadows open Hidden intents without revealing them, and reveals each one at its payoff or in the Results Stretch.
- [x] Choose two or three salient events per Stretch, weighted toward Cast Runners.
- [x] After the finish, the window shows a replay with stamina, decisions and intents per Runner per Stretch.
- [x] Roster avatars are Images referenced from `library_data`, set through "set avatar" in the window.
- [x] Add a local seed script that loads avatars from a gitignored folder, with a matching teardown.
- [x] Unit tests: no Hidden intent stays unrevealed after the Results Stretch.
- [x] Verify the replay manually with playwright-cli. No UI tests.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- No intent is visible in the window before the finish.
- The repository contains no Runner art.

## Notes

- The engine drives every Runner the writer gave no Moves: a planned closer conserves and then charges, the rest overtake by Running style and phase and spurt in the final 400 m. Engine decisions share `checkRunnerMove` with the writer's Moves.
- The one Hidden intent is a late charge, formed in Stretch 1 by up to two Late Surgers or End Closers (chance by Wit) when the course has ground before the final 400 m. It pays off in the Stretch its spurt succeeds, else in the Results Stretch. Hints describe only what a spectator sees, stop at the final 400 m, and skip a Runner the writer ordered that turn.
- Salient events are doubled for Cast Runners, read from gates that carry a `participantId`, so the Race Box fingerprint does not change when an unslotted Cast member joins.
- The race read sends a spectator state while running; the replay and intents arrive only once the race is finished.
- Roster avatars are written through ticket 09's `put-box-data` command (library owner, key `avatar:<name>`, bare Image hash), so this ticket commits after 09.
- Local avatars: put `<Runner name>.png` (or JPEG, WebP, GIF) in the gitignored `race-avatars/` folder, then run `bun run db:seed:race-avatars`; `bun run db:teardown:race-avatars` removes them.
- The field already spread 150 to 200 m over 2400 m before this ticket, so a late charge rarely changes the result. Rebalancing the pace model is out of scope here.
