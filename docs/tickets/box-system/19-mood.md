# Mood

Status: TODO

Blocked By: 18-rewrite-the-authoring-guide

Source: user request for a simple digesting Box; this ticket also re-tests the authoring guide.

## Goal

With the Mood Box inserted, each selected passage is read by a Decision Model that answers one question: what mood does this passage leave the scene in? The current mood shows as an emote beside the Chat, in the Mood dock tab, and the prompt carries one line such as "Scene mood: tense".

## Ownership

- Mood Box

## Work

- [ ] Build the Box using only `docs/box-system/authoring.md`. Record every place you had to leave the guide.
- [ ] Digest: one System One `choice` question per selected passage, `not clear, calm, warm, playful, tense, sad, eerie`. Record the answer; "not clear" keeps the previous mood.
- [ ] Fold to the current mood. `advance` adds one line to the prompt. `status` shows the emote and word.
- [ ] Writer override per passage and catch-up come from the host; do not build them.
- [ ] New Chats start without it.
- [ ] E2E: scripted decisions over two passages, the mood line in inspection, an override, a swipe that changes the mood.
- [ ] Record the number of files touched in this ticket, and every guide gap found.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The Box touches at most 6 files, tests included, and no host file.
