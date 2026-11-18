# T5: Wire

Status: IN PROGRESS

Blocked By: T4

Model: Sol 6.1 high.

Four changes to the HTTP contract and its client readers, done together so the client is touched once. There is no compatibility layer: every caller moves in the same slice.

Read ADR 0002 and 0023. Evidence: report 18, findings 2–5; report 20, finding 5. The tests that pin each wire detail are in report 24's change-coupling table (rows 1–3) and report 25's (rows 10–11).

## Slice a: one revision-conflict envelope

Report 18, finding 2.

Every stale-revision conflict has the shape `{ outcome: "conflict", reason: "stale-revision", expectedRevision, actualRevision, current }`, built by one shared `revisionConflict(currentSchema)` in `src/shared/contract/`. Delete the per-aggregate field names (`currentSettings`, `currentPreset`, `currentBook`, `currentState`, `currentCharacter`, `currentConversation`) and the switch in `src/server/revision.ts` that produces them.

Stays separate: the Prompt Preset deletion-impact conflict; a Generation start's stale revision, which reports prose; and Memory's conflict envelopes in `src/boxes/memory/contract.ts`, whose revisions are strings scoped to a Box instance.

`contract/domain-error.test.ts` is where the one shape is proved.

## Slice b: response maps declared once

Report 18, finding 3.

Each route family's response map is declared once in `src/shared/contract/`. The server route uses it as `response`. The client calls `requestOutcome(request, map)`, which takes the success schema from `map[200]` and the error union from the rest. Delete the `*Errors` unions that restate the non-200 entries, and the second schema argument at each client call.

Split this slice by route family if it passes about 30 files: Conversation first, then the libraries, then settings.

One known mismatch to fix on the way: the sibling Generation start in `src/client/conversation.ts` is paired with the preview's error union.

## Slice c: one Generation start route, and paint preset through the dispatcher

Report 18, finding 4; bug 8 in `bugs.md`.

- One `POST /api/conversations/:id/generations`, whose body is the union already discriminated by `kind` (`send`, `continuation`, `sibling`). `GenerationTarget` is derived from that schema. The preview request takes `{ target, ...options }` as the send route does, so the route stops flattening a target that the workflow rebuilds.
- The two paint preset commands become Conversation actions (`select-paint-preset`, `set-brief-message-count`) dispatched through `executeConversationCommand`, with an expected revision and a gate entry. Delete `commandPaintPreset`. **Behaviour change:** the Chat revision advances, and a stale client gets a conflict.
- Update `e2e/` route patterns and `scripts/profile-actions.ts`.

## Slice d: Lore attachment actions become commands

Report 18, finding 5; report 20, finding 5.

- The five Conversation-owned actions (`attach-chat`, `detach-chat`, `attach-participant`, `detach-participant`, and the Lore settings save) are sent to the Conversation commands endpoint. Delete the Lorebook route's re-dispatch, the mapped type that strips its envelope, and `readParticipantConversationId`.
- Character lore attachments become Character commands (`attach-lorebook`, `detach-lorebook`) in `character-library/execute.ts`, which already has the revision guard. Delete `executeLorebookAttachmentCommand` and `advanceCharacterRevision` from `lorebook/attachments.ts`. `lorebook/` stops writing the Character revision.
- The client's Lore attachment editor branches on owner kind in about eight places; it now picks one of two command senders.

## Rejected

- A global `onError` hook replacing the per-route `presentDomainError` calls: unproven against Elysia's response validation, and not scheduled.
- Storing Semantic Trigger settings in `library_data`, and the other revisioned-settings unification from report 18, finding 6.
- camelCase Drizzle keys with `casing`.

## TODO

- [x] Slice a, PR
- [ ] Slice b, PR (split by route family if large)
- [ ] Slice c, PR
- [ ] Slice d, PR

## Acceptance

`git grep -n -E 'current(Settings|Preset|Book|State|Character|Conversation)\b' -- src e2e` is empty. `git grep -n -E 'continue/generations|sibling/generations' -- src e2e scripts` is empty. Typecheck, unit tests and e2e pass in CI on each slice.

## Outcome

- Slice a puts stale-revision responses on one schema and migrates every caller in the same change. Prompt Preset deletion impact uses `current` and keeps its own reason. Generation starts still send prose, and Memory keeps its Box contracts.
- The old-field search finds Memory's explicit exception and one local `currentState` variable in the Prompt Preset editor. No core HTTP wire fields match.
- Slice a changed-file lint passed with three existing warnings. `git diff --check` passed. The first CI check stopped at typecheck. The follow-up uses the concrete shared fields for the generic editor type and preserves the literal tags in the test expectation.
