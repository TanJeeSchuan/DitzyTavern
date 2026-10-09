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
- **Behavior changed:** error messages become one of two shared copies where modules had bespoke strings — "The server could not be reached." for a fetch the transport never completed, "The server returned an unusable response." for an error status or a body that fails its contract. Intended.
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

`requestData(call, schema)` joined `requestOutcome` as the second transport seam. Both keep transport failure and unusable response apart: `requestOutcome` passes the route's modeled error union through verbatim, returns `{ outcome: "network" }` only when Eden's result carries no `Response` (a fetch the transport never completed), and returns the shared `{ outcome: "invalid", reason: SERVER_UNUSABLE_RESPONSE_NOTICE }` ("The server returned an unusable response.") for an error status or a body that fails either contract; `requestData` throws `NetworkError` with `SERVER_UNREACHABLE_NOTICE` for the former and a plain `Error` with `SERVER_UNUSABLE_RESPONSE_NOTICE` for the latter. `domainOutcome` deleted; `EdenResponse` kept (still used by `prompt-preset-library`'s recipe-operation type).

Route families whose modeled error unions had no shared schema yet got them next to their response schemas (`memorySettingsCommandErrors`, `semanticTriggerSettingsCommandErrors`, `memoryLabels/Collection/Allowance/CatchupCommandErrors`, `connectionCommandErrors`) — `check:contracts` forces those unions out of client files, and `requestOutcome`'s two-way `Static` check fails unless the union is exactly the route's derived error union.

- Reads across memory-settings, semantic-trigger-settings, memories, conversation (Generation Settings, summary, prompt preset), lorebook-library, character-library, connection-settings, updates, prompt-preset-library, workspace moved onto `requestData`; callers keep their signatures, and a surfaced failure carries whichever shared copy is true — unreachable for a failed fetch, unusable response otherwise.
- Reads that branch on a typed 404 (Conversation summary, prompt preset, Lorebook attachment state/impact/owner state/book, Character snapshot, match-test) decode through `requestOutcome` with `notFoundOutcome`, skip `not-found`, throw `NetworkError` for `network`, and throw a plain `Error` carrying the reason for the `invalid` fallback. The generation-session runner's back-off therefore retries only a genuinely unreachable transport, not an HTTP failure or a malformed page. The match-test 404 keeps its "That Lorebook no longer exists." copy as the one declared domain condition.
- Command sites (memory/semantic settings save, identity/labels/collection/allowance/catchup commands, connection commands/test/discovery) return the `requestOutcome` union; their callers (`MemorySettingsEditor`, `SemanticTriggerSettingsEditor`, `useConversationMemories`, the memory dialogs/popovers, `useConnectionSettingsController`, `ConnectionProfileEditor`, `ProfileModelPicker`, `GenerationErrorToast`) branch on `available` + `value`, and their `invalid` branch surfaces the seam's unusable-response reason. Existing catch-based failure notices stay as the network/unknown copy of each flow.
- `setTextOnlyModel` keeps its null projection at the boundary (its consumers read only applied/failed); everything else exposes the outcome union directly.
- `useConversationSession`'s history refresh loop calls `loadHistoryPage`; the modeled 404 skip and the classified transport/response throws replace the inline GET.

Review fix round 1:

- Finding 1 (P1): the first implementation folded HTTP failures and malformed payloads into `NetworkError`, so the generation-session runner retried permanent responses. Fixed at the shared boundary as described above: `{ outcome: "invalid", reason }` is the response failure and `network` is reserved for a result with no `Response`. `conversation-read.test.ts` and `useConversationSession.test.ts` again pin transport failure → `NetworkError` and HTTP failure/bad payload → plain `Error`, and the `requestOutcome`/`requestData` unit tests pin the same split, including Eden's malformed-JSON rejection. `chat-history.test.ts` and `import-chat.test.ts` pins that expected the old "network class" for unreadable responses now expect the shared invalid fallback.
- Finding 2 (P3): `connectionDiscoveryErrors` deleted; discovery uses `connectionCommandErrors`, and the wrong "test and discovery share an envelope set" comment is gone.
- Finding 3 (P3): unused `MemorySettingsCommandResult` and its `StaticDecode`/`RequestOutcome` imports deleted.
- Finding 4 (minor): each `useConversationMemories` handler replaces the collection once for its success and conflict branches.
- Consequence: `stopCommandOutcome` treats every outcome that is neither the typed 404 nor the applied stop as failed, since a response failure can now surface as `invalid` rather than `network`.
- Two unowned adapters whose comments describe the shared outcome contract (`import-chat.ts`, `new-chat.ts`) had those comments corrected in place; no behavior changed there, and their other tests already cover the outcome they consume.

Verification (review fix round 1): `bun run typecheck` exit 0; `bun run lint` exit 0 (warnings only; no warning in a changed file is new); `bun run check:contracts` exit 0 (631 structural declarations, 151 `Static<typeof Schema>` derivations, 11 advisory cross-layer matches); `bun test src/client` 282 pass / 0 fail; `bun run test` 1351 pass / 5 fail — the five are 5–10 s timeouts in three untouched server contract test files (`text-only-models`, `author-note`, `prompt-preset-recipe`) under parallel load; re-running those three files alone gives 39 pass / 0 fail.

Review fix round 2:

- Finding (P2): the round-1 fix reused `{ outcome: "invalid", reason: SERVER_UNUSABLE_RESPONSE_NOTICE }` for unusable responses, which collides with the genuine 422 `invalid` envelopes several routes model. `loadMacroVariables` returned the same `invalid` for both a real 422 and an HTTP 500, so `MacroVariablesPanel` showed the domain copy "This history position is not available." for a server failure. The synthetic member is gone: `requestOutcome` now produces `{ outcome: "unusable"; reason: SERVER_UNUSABLE_RESPONSE_NOTICE }` for an error status, an undecodable body, or an Eden parse rejection, while modeled error envelopes continue to pass through verbatim.
- Consumers that switched on `invalid` now handle `unusable` explicitly. Reads whose route models no `invalid` (Conversation summary and prompt preset, Character snapshot, the Lorebook reads, the history refresh) throw a plain `Error` carrying the reason. Consumers of routes that do model `invalid` — the macro-variables and generation-details reads; `runConversationCommand`; the character, Lorebook, memory, semantic-trigger, prompt-preset, connection, import, and new-chat commands; the assembly preview; `renameChat` — carry both arms and surface the reason for either. No consumer maps `unusable` onto `NetworkError`, so the generation-session runner still retries only an unreachable transport.
- New pin: `request-outcome.test.ts` "an HTTP failure on a route with a modeled invalid envelope is unusable, never the modeled envelope"; the existing synthetic-fallback pins in `request-outcome.test.ts`, `chat-history.test.ts`, and `import-chat.test.ts` now expect `unusable`.

Verification (review fix round 2): `bun run typecheck` exit 0; `bun run lint` exit 0 (warnings only; no new warning in a changed file); `bun run check:contracts` exit 0 (632 structural declarations, 151 `Static<typeof Schema>` derivations, 11 advisory cross-layer matches); `bun test src/client` 283 pass / 0 fail.
