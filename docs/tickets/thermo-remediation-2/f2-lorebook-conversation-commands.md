# Lorebook attachment commands route through the Conversation seam

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F2.

## Goal

`src/server/lorebook/attachments.ts` re-implemented Conversation's revision
machinery: a second `advanceConversationRevision` with its own stale-error
class, duplicated `conversation_control`/`participant` reads, a Conversation
row read twice in one function, and five near-identical command branches.
The five Conversation-owned commands now execute through the canonical
Conversation command seam; only the two Character-owned commands stay in the
Lorebook module.

## Mechanics

**Machinery removed**

- `StaleLoreAttachmentRevisionError` and its 409 fan-out in
  `contract/lorebook-routes.ts` (the per-command-type state re-read switch).
- The duplicate `advanceConversationRevision` in `attachments.ts` —
  Conversation-owned commands now advance through
  `advanceConversationRevisionGuarded` inside `executeConversationCommand`.
- Three of the five `executeLorebookAttachmentCommand` branches
  (attach-participant, detach-participant, the combined
  attach-chat/detach-chat/save-settings branch) and the two dead write
  primitives `detachLorebookFromConversation`, `attachLorebookToParticipant`,
  `detachLorebookFromParticipant`.
- `InvalidLoreAttachmentCommandError` — its only thrower (Chat Lore settings
  validation) moved into the Conversation handler, which throws the
  canonical `InvalidConversationCommandError` with the same messages.
- The duplicated direct reads of `conversation_control` and the active Cast
  in `readLorebookAttachmentEligibility` (now `readControlAssignment` /
  `readActiveCast` from `conversation/internal.ts`), and the double
  Conversation read in `readLorebookAttachmentState`.

**Machinery introduced**

- Five `ConversationAction` variants (attach-chat, detach-chat,
  attach-participant, detach-participant, save-settings), derived from the
  shared Lorebook command schema with the route envelope (conversation id,
  expected revision) stripped — the shapes cannot drift from the wire
  contract the client posts.
- `conversation/commands/lore-attachments.ts`: five policy handlers owning
  the Lore attachment and Lore settings writes, each reporting
  `{ conversationId, touchedVariantIds: [], removedVariantIds: [],
  promptPresetChanged: false }` — attachment changes touch no Variant rows,
  and the empty record is a no-op in `memory/sync.ts`, so Memory behavior is
  unchanged.
- Five `conversationCommandPolicy` rows stating their real gates: no
  playability requirement and no Active-Generation block for any of the
  five — the replaced Lorebook seam enforced only the revision guard, and a
  running Generation keeps its captured plan (like select-prompt-preset).
- `StaleLoreAttachmentOwnerRevisionError` in `lorebook/errors.ts`: the
  Character-scoped stale conflict for the two remaining commands, carrying
  only the identifiers the route's recovery payload needs.
- `readParticipantConversationId` in `attachments.ts`: Participant commands
  carry no conversation id on the wire, so the transport derives the target
  Conversation from the Participant's own Chat reference before dispatch.

**Behavior**

- Wire conflict payload for Chat/Participant attachment changes (attach-chat,
  detach-chat, attach-participant, detach-participant, save-settings) is now
  the Conversation conflict shape — `currentConversation` with the
  authoritative summary — instead of the Lorebook attachment
  `currentState` union. Status codes are unchanged (409 on stale, 404 on
  missing owner). The client's conversation-conflict handling already
  exists (`useCastActions` via the conversation command runner).
- The Character-owned conflict payload is unchanged
  (`currentState` with the owner's attachment list).
- Everything else wire-visible is unchanged: same 200 applied shape, same
  422 invalid reasons for bad Lore settings, same 404s, same revision
  advancement (one bump per committed write), same Memory ordering.

## Verification

- `bun run typecheck` — clean; `bun run lint` — exit 0 with the same 39
  pre-existing warnings as the base commit, none in changed files;
  `bun run check:contracts` — exit 0, identical audit counts as the base.
- `bun test src` — 1304 pass / 0 fail.
- Full Playwright suite (`bun run test:e2e`) — 32 passed, including the
  lore spec that attaches a Lorebook to the Chat through the rewired route.
- `rg -n 'StaleLoreAttachmentRevisionError' src/` — 0 matches.
- `rg -n 'advanceConversationRevision' src/server/lorebook/` — 0 matches.
- No production file crossed 1,000 lines; the only file above the guard is
  the pre-existing `src/styles/story.css`, unchanged by this work.

## Residual (accepted)

- The stale Conversation conflict mapping is rebuilt locally in
  `contract/lorebook-routes.ts` because the equivalent helper in
  `contract/conversation.ts` is file-private and outside this finding's
  ownership; a later pass can hoist one shared builder.
- ~~The client's Lore panel still words attachment-command conflicts with its
  generic notice until the client adopts the Conversation conflict payload
  (`client` is out of scope here).~~ Resolved by the follow-up below: the
  generic notice wording stays, and the stale-revision recovery now works.

## Follow-up (post-rebase P1): Lore conflict retries stayed stale

The F8 client-transport canonicalization (base `a9edc0f`) modeled the
Lorebook attachment command error union without the Conversation conflict
shape, so the route's actual 409 for the five Conversation-owned commands
failed the error decode and surfaced as `network` — the Lore editors skipped
their conflict reload and kept submitting the stale revision until the
surface was reopened.

**Changed**

- `loreAttachmentCommandErrors` now composes the route's exact 409 union
  (`loreAttachmentCommandConflict`: the Character-attachment conflict plus
  the Conversation conflict shape) with the shared 404/422 envelopes; the
  requestOutcome two-directional pin makes any future mismatch a compile
  error.
- `LorebookPanel.updateAttachment` recognizes the modeled conflict outcome:
  it refetches the `lorebook-attachments` query (awaited, so the fresh
  revision is in the cache before the notice shows) and no longer seeds the
  cache from a `currentState` payload that no longer exists.
- `LoreAttachmentEditor` needed no new machinery — its reload-on-conflict
  reuses the owner attachment reader and now compiles against the modeled
  union for both conflict shapes.
- `e2e/lore.spec.ts` covers both surfaces: an API-side Chat edit advances the
  revision → submit conflicts → the surface reloads → the same unchanged
  action retried succeeds without reopening (panel detach, participant
  attach).

**Verification** — `bun run typecheck`, `bun run lint` (exit 0, same 39
pre-existing warnings as base), `bun run test` (1309 pass / 0 fail),
`bun run check:contracts` (exit 0), `bun run test:e2e` (34 passed) all green.
