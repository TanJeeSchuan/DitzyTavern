# B3 — F8 completion: the wire word was not adopted

## Status

Implemented on `fix/thermo-f8-outcome-adoption`.

## Source

`.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F8 (client transport):
`src/client/import-chat.ts` and `src/client/chat-history.ts` still carried their own hand-written
outcome unions and transport bodies, and ~18 client files still spelled the client outcome
discriminant `status` where the wire word is `outcome`.

## Mechanics

**Machinery removed**

- `import-chat.ts`: the `ChatImportStageOutcome` / `ChatImportPreviewOutcome` /
  `ChatImportCommitOutcome` hand-written unions, the staged transport's whole hand-written
  request/response seam (`wireBody`, `parseInvalidResponse`, `parseGoneResponse`, `parseStageResponse`,
  `parsePreviewResponse`, `parseCommitResponse`, the per-method `try { … } catch → network` blocks),
  and the `ChatImportTransport` options/factory scaffolding (`ChatImportTransportOptions`,
  `createChatImportTransport`, default-boundary `chatImportTransport`). The unused contract re-exports
  (`SuggestionMatchKind`, `ChatImportResolvedOutcome`, `ChatImportDuplicateMatch`, …) went with it.
- `chat-history.ts`: the `ChatHistoryOutcome` / `ChatImportDetailsOutcome` hand-written unions, the
  `parseHistoryResponse` / `parseImportDetailsResponse` blocks and the load-method `try → network`
  bodies, and the `ChatHistoryTransport` options/factory scaffolding.
- The `status` outcome discriminant everywhere it named a transport outcome, with consumers migrated
  in the same commits: `ImportChatPanel.tsx`, `ChatInformationPanel.tsx` (download state union),
  `workspace/useConversationSession.ts`, `workspace/useStoryMessageActions.ts`, and the two
  transport test files. The two leftover rename-and-forward parameters (`MacroVariablesPanel.tsx`
  `errorText(status: …)`, `GenerationDetailsPanel.tsx` `showError(status: …)`) now say `outcome`.
- Both test files' `fetchImpl` injection scaffolding: they now drive the module through a patched
  `globalThis.fetch`, the `request-outcome.test.ts` precedent.

**Machinery introduced**

- One shared error-union schema: `chatImportCommandErrors` in `src/shared/contract/chat-import.ts`,
  the composed `410`/`422` envelopes (`importGoneResponse` + `invalidOutcome`) every staged route
  declares, placed next to its members like the F8 family unions.

**Route mapping (all five wire routes ride `requestOutcome`)**

- `stageImport` — Treaty `.post(undefined, { headers, fetch: { body: bytes } })`: the stage route
  declares no body schema (Elysia streams the raw request), so the Blob travels through the fetch
  init and only the leaf filename rides `x-import-filename`. Treaty's own body typing would have
  JSON-stringified the Blob; the fetch-init pass-through keeps the exact bytes and the wire request
  identical. Errors: `invalidOutcome` (the route's only modeled envelope).
- `previewImport` / `commitImport` — Treaty JSON bodies; errors `chatImportCommandErrors`.
- `discardImport` — Treaty `.post(undefined)`: no body, no content-type, byte-identical to the
  fetch the old client sent; the route models no errors, so no outcome is requested of it.
- `loadHistoryPage` / `loadImportDetails` — Treaty GET with the 200 schema (`chatHistoryPage`,
  `chatImportDetails`) and `notFoundOutcome` (each route's only modeled envelope).

**The one byte-protocol exception**

`downloadExactSource` stays a deliberately manual read, like the Generation and update
EventSource streams: the exact-source route streams raw file bytes under the artifact's own media
type (Elysia typegen even types the 200 as `Response`), so there is no 200 wire schema to decode
and no way through `requestOutcome` — the decoded wire union has no member for raw bytes, and the
sanitized filename and media type come from response headers, which no decoded payload carries.
What survives is the minimum byte read plus the only decoded part (the typed 410 cleaned-up
envelope); the unit e2e still pins the byte-exact download end to end.

**Behavior**

None on the wire. The e2e suite passes with zero fixture changes (scripted fakes, scripted LLM, the
byte-exact preserved-source download). Two client-side classifications align with the canonical
`requestOutcome` semantics and no longer special-case statuses the routes never declare: a
non-modeled HTTP failure is `network` (the old chat-history transport called it `invalid`), and a
gone-state body that fails its contract is `network` (the old import transport degraded it to
`expired`). Both only affect bodies the server never emits; the typed envelopes (staged, available,
committed, invalid, expired, unavailable, not-found, cleaned-up) decode exactly as before.

## Verification

`bun run typecheck`, `bun run lint`, `bun run test` (1336 pass), `bun run check:contracts` (audit
exit 0), `bun run test:e2e` (36 pass, no fixture edits). Audit: zero `try {` lines carrying
`outcome`/`decode` in the two files; every remaining `"status"` in `src/client` is an ARIA
`role="status"`, a genuine HTTP `error.status` (Treaty), a wire field (artifact availability,
memory source/indexing status, `GenerationInspectionStatus`), or a presentation/session state union
outside the transport vocabulary. File-size guard: largest production file 684 lines.
