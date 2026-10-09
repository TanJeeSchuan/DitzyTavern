# T5 — One client read dialect: `requestData`

Status: TODO

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

- [ ] Add `requestData`
- [ ] Migrate the `domainOutcome` sites; delete `domainOutcome`
- [ ] Migrate the hand-rolled unwraps file by file
- [ ] Replace the inline history GET in `useConversationSession` with `loadHistoryPage`
- [ ] typecheck, lint, `bun run test`
- [ ] Commit

## Acceptance

`grep -rn 'domainOutcome' src` is empty; `grep -rnE 'if \(error \|\| !data\)' src/client` is empty.

## Outcome
