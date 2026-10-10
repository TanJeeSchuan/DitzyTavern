# Cast members race with their own stats

Status: TODO

Blocked By: 06-race-engine-in-the-prompt

Source: `docs/box-system/spec.md`, User Stories 24–25; Implementation Decisions "Storage scopes", "Race Box" (Character data, Participant data, slots, withdrawal); GLOSSARY "Definition", "Participant".

## Goal

A writer adds Special Week from the Cast to a race. She has no stats yet, so a stat sheet lets the writer roll or set them and save them back to her Character. In a new Chat seeded from that Character she brings the same stats.

## Ownership

- `character_data` and `participant_data`
- Copying Box data when a Character seeds a Participant
- Race stat sheets and Cast slots

## Work

- [ ] Add `character_data` and `participant_data` (owner, namespace, key, value), cascading with their owners.
- [ ] Copy every `character_data` row into `participant_data` when a Character seeds a Participant. Later Character edits never reach existing Participants.
- [ ] Add a host command for a Box window to write its own Character, Participant and library data.
- [ ] Race window: "Add from Cast" lists unslotted Cast members. A stat sheet lets the writer roll or set stats and Running style, and save back to the Character.
- [ ] Exclude a roster Runner who shares a name with a slotted Cast member.
- [ ] Cast Runners use their Portrait, focal point included, in the Race window.
- [ ] A Cast Runner removed from the Cast mid-race is withdrawn, and the next item says so.
- [ ] E2E: seed copy; Character edit not reaching an existing Participant; a Cast Runner in the race item.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Stats in Participant data persist across races in the same Chat.
