# Race drama and replay

Status: TODO

Blocked By: 06-race-engine-in-the-prompt

Source: `docs/box-system/spec.md`, User Stories 29–30; Implementation Decisions "Race Box" (advance item, library data, window); GLOSSARY "Hidden intent".

## Goal

Gold Ship breaks last on purpose. The narrator is told to foreshadow it without revealing it, and when she charges in the final Stretch the item says "Reveal now: the late start was planned." After the finish, the Race window replays every Runner's decisions Stretch by Stretch. Roster Runners show their avatars.

## Ownership

- Race Hidden intents and salience
- Race replay
- Roster avatars

## Work

- [ ] The engine records each Runner's decisions per Stretch and pairs a Hidden intent with its payoff Stretch.
- [ ] The advance item foreshadows open Hidden intents without revealing them, and reveals each one at its payoff or in the Results Stretch.
- [ ] Choose two or three salient events per Stretch, weighted toward Cast Runners.
- [ ] After the finish, the window shows a replay with stamina, decisions and intents per Runner per Stretch.
- [ ] Roster avatars are Images referenced from `library_data`, set through "set avatar" in the window.
- [ ] Add a local seed script that loads avatars from a gitignored folder, with a matching teardown.
- [ ] Unit tests: no Hidden intent stays unrevealed after the Results Stretch.
- [ ] Verify the replay manually with playwright-cli. No UI tests.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No intent is visible in the window before the finish.
- The repository contains no Runner art.
