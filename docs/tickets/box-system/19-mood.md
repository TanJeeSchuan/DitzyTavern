# Mood

Status: DONE

Blocked By: 18-rewrite-the-authoring-guide

Source: user request for a simple digesting Box; this ticket also re-tests the authoring guide.

## Goal

With the Mood Box inserted, each selected passage is read by a Decision Model that answers one question: what mood does this passage leave the scene in? The current mood shows as an emote beside the Chat, in the Mood dock tab, and the prompt carries one line such as "Scene mood: tense".

## Ownership

- Mood Box

## Work

- [x] Build the Box using only `docs/box-system/authoring.md`. Record every place you had to leave the guide.
- [x] Digest: one System One `choice` question per selected passage, `not clear, calm, warm, playful, tense, sad, eerie`. Record the answer; "not clear" keeps the previous mood.
- [x] Fold to the current mood. `advance` adds one line to the prompt. `status` shows the emote and word.
- [x] Writer override per passage and catch-up come from the host; do not build them.
- [x] New Chats start without it.
- [x] E2E: scripted decisions over two passages, the mood line in inspection, an override, a swipe that changes the mood.
- [x] Record the number of files touched in this ticket, and every guide gap found.
- [x] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The Box touches at most 8 files, tests included: its own shared, server and client modules, its tests, and one entry in `boxIds`/`boxDescriptors`, one in the server registry and one in the client registry.

## Result

Eight files: `src/shared/mood.ts`, `src/server/box/mood.ts`, `e2e/mood.spec.ts`, the entries in `src/shared/contract/box.ts`, `src/server/box/registry.ts` and `src/client/box-windows/registry.tsx`, a host fix in `src/server/box/records.ts`, and this ticket. No window file: the generic timeline and dock tab are enough.

Guide gaps:

- **`records.digest`.** The guide names `ctx.decide(state, questions)` and says the World Clock asks `choice` questions, but shows neither a question's shape (`{ type: "choice", instructions: { question }, criteria: { <option>: <text> } }`) nor the answer's (a `Map` of `DecisionAnswer`s whose `choice` must be checked). I read `src/server/decision-model/index.ts` and the World Clock's digest.
- **Host generality, step 3.** With a second digesting Box, `src/server/box/digest.ts` stopped typechecking: `effectiveRecord` and `hasAutomaticRecord` in `records.ts` inferred one Box's record from a union of slots. I made them generic over the slot. Per the guide this is a missing host generalization; it is fixed here rather than special-cased.
- **Record schema, Passage timeline.** A choice field built as `Type.Union([a, ...names.map(Type.Literal)])` typechecks on the server but collapses the `set-box-record` route type to the first literal (TS2719 in `src/client/conversation.ts`). The union must be a fixed tuple. The guide does not say so.
- **`status`, Window.** The guide does not give the generic dock tab's accessible name, `<label>: <status>`, which the e2e spec needs. I read `DigestDockTab` in `PassageTimeline.tsx`.
- **Test it, step 5.** The guide does not say that a Human-authored passage is digested too, so the scripted Decision Model needs a catch-all rule after the passage-specific ones (rules match first-hit). The World Clock spec shows it without saying why.
