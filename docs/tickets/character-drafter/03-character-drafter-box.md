# Character Drafter Box

Status: TODO

Blocked By: 01, 02

Source: `docs/specs/character-drafter.md`, User Stories 1–18; Implementation Decisions 5–10.

## Goal

Writers draft a Definition for anyone in the story from the Character Drafter's window or a Cast member's Participant editor, and keep it through the core Definition editor.

## Ownership

- `src/boxes/character-drafter/` (new)
- `src/box-sdk/client.ts` (`openDefinitionDraft`)
- `src/client/characters/` (opening `DefinitionEditor` with a draft and the three actions)

## Work

- [ ] Descriptor: `character-drafter`, `startsEnabled: true`, empty instructions, no `advance`, records or fold.
- [ ] Route `POST /api/boxes/character-drafter/draft` `{ conversationId, person, instruction?, participantId? }`: capture `messages`, `cast` and `boxExports` (without its own entry) at the start, call `runCodeAgent`, stream activity and then the draft or the failure over SSE; closing the stream cancels the run.
- [ ] Instructions: established facts as facts, a labeled reputation paragraph in `identity` for what others say, the person's beliefs as their point of view, `exampleDialogue` from quotes alone, `<thought>` tags mark unspoken thoughts, a fuller name when the story gives one.
- [ ] Submit schema `{ name, prompt, quotes }`; `verify` refuses a quote that isn't a substring of its Message and an `exampleDialogue` line that isn't a quote.
- [ ] `openDefinitionDraft(draft, { conversationId, replaces? })` opens `DefinitionEditor` prefilled with Add to Cast (`add-participant`), Save as Character, and, with `replaces`, Replace: confirm first, then rename and `replace-participant-prompt`, keeping Portrait and openings. Closing discards the draft.
- [ ] Window: person picker (labels from `exports.memory.people()` plus a name field), instruction field, activity feed with each step expandable to code and output, cancel, open-draft button. Disabled with the reason when no agent model is set. Follow DESIGN.md.
- [ ] `ParticipantSection`: "Draft from story" drafts that Participant and opens the result with `replaces`.
- [ ] Tests: `verify` cases above. One e2e flow scripted with `llm.authoring`: draft from the window with Memory enabled and add to the Cast; draft a Cast member from the Participant editor, confirm Replace, and see the Portrait kept.
- [ ] Run focused tests and lint on changed files; push and let CI run the rest.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The Box writes nothing to the Cast, the library or its own storage; only the writer's choice in the editor does.
- Without Memory, drafting still works from raw history.
