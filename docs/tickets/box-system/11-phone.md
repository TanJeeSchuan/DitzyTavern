# Phone

Status: TODO

Blocked By: 08-play-a-race-with-moves

Source: `docs/box-system/spec.md`, User Stories 32–34; Implementation Decisions "Phone Box", "Moves"; GLOSSARY "Phone".

## Goal

Elara texts "u still up?" inside her reply. The text vanishes from the prose and appears in her Phone thread, with `📱 1 unread` in the dock. The writer replies from the Phone, as a turn containing only that text.

## Ownership

- Box `lens`
- Phone Box

## Work

- [ ] Add `lens` (`strip`, `View`) to the contract. The story view renders lens-stripped segments, and the prompt keeps the markup.
- [ ] Strip `<sms from to>` only when both names are the human-controlled Participant and a Cast member. Leave any other markup as raw text.
- [ ] Add one thread per Cast member, built from the Selected narrative path.
- [ ] Outgoing texts are Moves rendered as `<sms>` from the human-controlled Participant.
- [ ] `advance` contributes one item teaching the markup.
- [ ] Unread counts are client-side and shown in `status`.
- [ ] Unit tests: the lens on malformed, nested and unknown-name markup.
- [ ] E2E: a scripted reply containing a text appears in the thread and not in the prose; a Phone-only reply turn.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Swiping a reply changes the thread to the new Variant's texts.
