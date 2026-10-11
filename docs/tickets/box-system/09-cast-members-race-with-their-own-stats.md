# Cast members race with their own stats

Status: DONE

Blocked By: 06-race-engine-in-the-prompt

Source: `docs/box-system/spec.md`, User Stories 24–25; Implementation Decisions "Storage scopes", "Race Box" (Character data, Participant data, slots, withdrawal); GLOSSARY "Definition", "Participant".

## Goal

A writer adds Special Week from the Cast to a race. She has no stats yet, so a stat sheet lets the writer roll or set them and save them back to her Character. In a new Chat seeded from that Character she brings the same stats.

## Ownership

- `character_data` and `participant_data`
- Copying Box data when a Character seeds a Participant
- Race stat sheets and Cast slots

## Work

- [x] Add `character_data` and `participant_data` (owner, namespace, key, value), cascading with their owners.
- [x] Copy every `character_data` row into `participant_data` when a Character seeds a Participant. Later Character edits never reach existing Participants.
- [x] Add a host command for a Box window to write its own Character, Participant and library data.
- [x] Race window: "Add from Cast" lists unslotted Cast members. A stat sheet lets the writer roll or set stats and Running style, and save back to the Character.
- [x] Exclude a roster Runner who shares a name with a slotted Cast member.
- [x] Cast Runners use their Portrait, focal point included, in the Race window.
- [x] A Cast Runner removed from the Cast mid-race is withdrawn, and the next item says so.
- [x] E2E: seed copy; Character edit not reaching an existing Participant; a Cast Runner in the race item.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Stats in Participant data persist across races in the same Chat.

## Coordination with ticket 10

Ticket 10 (Race drama and replay) is being implemented in the same worktree. Shared seams it introduces:

- The Race Box dependencies gain `cast: string[]`, the Cast member names from `summary.cast` in `src/server/box/registry.ts`. `race-engine.ts` uses it to weight salient events toward Cast Runners. Withdrawal can read the same field.
- `RaceOval` takes `avatars: ReadonlyMap<string, Portrait>` keyed by Runner name. Ticket 10 fills it with roster avatars from `RaceRead.avatars`; add Cast Portraits to the same map.
- Roster avatars are written by `PUT /api/boxes/race/avatars` into `library_data` (`box:race`, key `avatar:<name>`, value the bare Image hash). If the generic Box-window host command here covers library data, move the avatar write onto it.

### Ticket 09 side (planned, from the 09 implementer)

- `raceRunner` gains optional `participantId`; "Add from Cast" sets it and roster Runners leave it unset.
- The Race dependencies also gain `withdrawn: string[]`, the slot names whose Participant is no longer in `summary.cast`. `generate-capture.ts` computes it from the Cast Participant ids; `registry.ts` forwards it.
- Withdrawal is applied in `race.ts` around `advanceRace`: prune those Runners from the captured slots, folded standings, intents and replay, then add `X is withdrawn.` to the item. `advanceRace` itself stays untouched to avoid colliding with ticket 10's rewrite.
- Race stat sheets read `participant_data` (`box:race`, key `stats`) through a new `GET /api/conversations/:id/boxes/race/cast`, and write through a new `put-box-data` conversation command (owner: library, character or participant; namespace always `box:<id>`).
- The host command is deliberately raw: the owning window writes a decoded JSON value string, and the read decodes it against the Race stats schema (clearing the namespace is the remedy for a bad value). The roster-avatar write can move onto it as-is because the bare hash is stored verbatim.

### Blocker observed while running ticket 09's checks (for the orchestrator / ticket 10)

`bun run test` fails one test, `Prompt Plan inspection > keeps a preview valid after an unrelated cast addition`, with a 422: ticket 10's `cast: summary.cast.map(({ name }) => name)` dependency enters the Race Box fingerprint (`advance.fingerprint` serializes every dependency), so adding an unrelated Cast member makes an existing Race preview stale. Ticket 09's `withdrawn` dependency is stable across that addition. The likely fix is to fingerprint only what changes the captured item, e.g. the slotted Cast names plus `withdrawn`, not the whole Cast roster. Ticket 10's two new untracked files `src/server/database/seed-race-avatars.ts` and `teardown-race-avatars.ts` also fail `bun run typecheck` (`.run()` is typed as `void`); they are left uncommitted with ticket 10's other files.

## Validation

- `bun run test:e2e`: 47 passed, including the new `e2e/race-cast.spec.ts`.
- `bun run lint`, `bun run lint:rules`, `bun run check:contracts`, `bun run typecheck:tools`, `bun run test:e2e:harness`: pass.
- `bun run test`: 1478 pass, 1 fail — only ticket 10's fingerprint staleness test noted above.
- `bun run typecheck`: clean except ticket 10's two untracked seed scripts noted above.
- Review: `gpt-6.1-sol` high over four rounds (three via the Codex CLI before the T3 `delegate_task` surface was requested, one final via `delegate_task` plus a `delegate_task` verification). The first round found six issues (stale-read stat sheet, save sequence, two-runner withdrawal, same-name roster slot, save guard, native checkbox); the delegated round then found three more (case-insensitive name matching, withdrawal persistence without a Stretch, sheet lifecycle guards). All nine were fixed and the final delegated verification reported no remaining blockers within scope.
