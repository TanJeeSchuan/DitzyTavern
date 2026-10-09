# T5 — One client read dialect: `requestData`

Status: DONE

Blocked By: None

Source: issue #52, finding **F7**.

## Problem

Round 3 put command outcomes on `requestOutcome` (`src/client/lib/request-outcome.ts`). Reads have three dialects:
(a) `requestOutcome`; (b) `domainOutcome` in `src/client/lib/eden.ts:19`, used by `memory-settings.ts`,
`semantic-trigger-settings.ts`, `memories.ts` (9 sites, ids stringified via `String(conversationId)`);
(c) hand-rolled `{ data, error } … if (error || !data) throw` in `conversation.ts` (13), `lorebook-library.ts` (6),
`character-library.ts` (`error.status === 404`), `connection-settings.ts` (`data ?? invalid`), `updates.ts`, and
`workspace/useConversationSession.ts` (~:150-154), which inlines the history GET with its own 404/decode handling
instead of calling `loadHistoryPage` in `chat-history.ts`.

## Files owned

`src/client/lib/eden.ts`, `src/client/lib/request-outcome.ts`, `src/client/{memory-settings,semantic-trigger-settings,memories,conversation,lorebook-library,character-library,connection-settings,updates,chat-history}.ts`,
the history-fetch lines of `src/client/workspace/useConversationSession.ts` (only those lines; T9c owns the rest of that file later), and their tests.

## Mechanics

- **Remove:** `domainOutcome`; the ~25 hand-rolled `{data,error}` unwraps; the inline history fetch in `useConversationSession`.
- **Introduce:** `requestData(call, schema)` next to `requestOutcome` for "throw on anything but 200" reads (≈6 lines), decoding through `decodeWirePayload`.
- **Behavior changed:** error messages become the shared "could not be reached" copy where modules had bespoke strings. Intended.
  Where a caller genuinely branches on 404 (e.g. `character-library.ts`), use `requestOutcome` with the modeled not-found envelope instead of `requestData`.

## Rejected

- Keeping `domainOutcome` as the "settings dialect": it differs from `requestOutcome` only by not decoding the payload, which must happen at the boundary.

## TODO

- [x] Add `requestData`
- [x] Migrate the `domainOutcome` sites; delete `domainOutcome`
- [x] Migrate the hand-rolled unwraps file by file
- [x] Replace the inline history GET in `useConversationSession` with `loadHistoryPage`
- [x] typecheck, lint, `bun run test`
- [x] Commit

## Acceptance

`grep -rn 'domainOutcome' src` is empty; `grep -rnE 'if \(error \|\| !data\)' src/client` is empty.

## Outcome

`requestData(call, schema)` joined `requestOutcome` as the second transport seam: await + decode through `decodeWirePayload`, and every miss — error status, undecodable 200 body, failed fetch — thrown as `NetworkError` with the shared `SERVER_UNREACHABLE_NOTICE` ("The server could not be reached."). `domainOutcome` deleted; `EdenResponse` kept (still used by `prompt-preset-library`'s recipe-operation type).

Route families whose modeled error unions had no shared schema yet got them next to their response schemas (`memorySettingsCommandErrors`, `semanticTriggerSettingsCommandErrors`, `memoryLabels/Collection/Allowance/CatchupCommandErrors`, `connectionCommandErrors`, `connectionDiscoveryErrors`) — `check:contracts` forces those unions out of client files, and `requestOutcome`'s two-way `Static` check fails unless the union is exactly the route's derived error union.

- Reads across memory-settings, semantic-trigger-settings, memories, conversation (Generation Settings, summary, prompt preset), lorebook-library, character-library, connection-settings, updates, prompt-preset-library, workspace moved onto `requestData`; callers keep their signatures, so the only UI-visible change is the shared throw copy on raw surfaced failures.
- Reads that branch on a typed 404 (Conversation summary, prompt preset, Lorebook attachment state/impact/owner state/book, Character snapshot, match-test) decode through `requestOutcome` with `notFoundOutcome` and fold `network` to the shared `NetworkError`, preserving the offline-recovery `NetworkError` the generation-session runner backs off with. The match-test 404 keeps its "That Lorebook no longer exists." copy as the one declared domain condition.
- Command sites (memory/semantic settings save, identity/labels/collection/allowance/catchup commands, connection commands/test/discovery) return the `requestOutcome` union; their callers (`MemorySettingsEditor`, `SemanticTriggerSettingsEditor`, `useConversationMemories`, the memory dialogs/popovers, `useConnectionSettingsController`, `ConnectionProfileEditor`, `ProfileModelPicker`, `GenerationErrorToast`) branch on `available` + `value`. Existing catch-based failure notices stay as the network/unknown copy of each flow.
- `setTextOnlyModel` keeps its null projection at the boundary (its consumers read only applied/failed); everything else exposes the outcome union directly.
- `useConversationSession`'s history refresh loop calls `loadHistoryPage`; the modeled 404 skip and the network throw replace the inline GET.

Behavior changed beyond the ticket text: refreshStory and loadConversation now throw `NetworkError` for every unclassifiable response (HTTP failure, malformed page, offline alike) instead of only for refused fetches, because `loadHistoryPage` folds that classification — the runner's back-off loop therefore also retries during HTTP failures, and the "does not classify HTTP failure as a transport outage" pins were replaced by "same NetworkError" pins (the folded dialect).

Verification: `bun run typecheck` clean for client/shared (pre-existing `src/server/revision.ts`-family errors belong to T4's in-flight work in this shared worktree); `bun run lint` clean for owned files (remaining pre-existing warnings are other tickets' files); `bun run check:contracts` passes; `bun run test` 1354 pass / 0 fail; manual smoke through a read-only vite dev run of Memory/Settings/Lorebooks/Characters/Prompt Presets panels confirmed the decoded reads and one applied Memory-settings toggle command.
