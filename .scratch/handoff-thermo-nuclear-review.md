# Handoff — Thermo-Nuclear Code Quality Review (current branch)

Date: 2026-08-29
Repo: /d/Projects/DitzyTavern
Branch: master (clean working tree)
Scope: review of the three commits ahead of origin/master on the current branch

## State of the repo

- `origin/master` = `d825b61`
- `HEAD` = `37327b6`
- Reviewed range: `git diff origin/master...HEAD`
- Commits:
  - `1567f57` Add repository architecture enforcement
  - `3c766ee` Enforce typed server contracts and transaction boundaries
  - `37327b6` Deduplicate same-knowledge contract adapter responses

## Checks already run (all green)

- `bun run lint` — 0 warnings, 0 errors
- `bun run lint:rules` — 22 pass, 0 fail
- `bun run check:contracts` — 0 hard violations; 75 suspicious cross-layer shape matches (advisory)
- `bun run typecheck` — clean
- `bun run typecheck:tools` — clean
- `bun test src` — 573 pass, 0 fail
- `bun run check:clones` — advisory only; see `.reports/jscpd/jscpd-report.sarif`

Full `bun run check` was not run as one command, but its components were run individually and passed.

## Review verdict

The migration direction is right (schemas in `src/shared/contract`, route adapters in `src/server/contract`, client decode via `Value.Decode`), but the branch is not at the thermo-nuclear approval bar. See findings below.

## Findings from this review

1. **High — circular import between adapter layers**
   - `src/server/contract/payload.ts:4` imports `toCharacterPayload` from `./character-library`.
   - `src/server/contract/character-library.ts:24` imports `staleCharacterConflictResponse` from `./payload`.
   - Remedy: move `toCharacterPayload` (and ideally `toConversationSummary`) into a shared projections module and import from there; break the cycle.

2. **High — `ConnectionSettingsCommandPayload` restates the command schema**
   - `src/shared/contract/connection-settings.ts:83` defines `commandBody`.
   - `src/shared/contract/connection-settings.ts:227` manually re-declares the full command union.
   - `src/shared/contract/connection-settings.ts:279` manually re-declares the result union.
   - Remedy: derive from `Static<typeof commandBody>` with a distributive `Omit` that strips legacy `backendOptions`; compose result types from the existing response schemas.

3. **High — custom oxlint rule incorrectly flags inline type-only imports**
   - `tools/oxlint/ditzy/rules/no-server-runtime-imports-in-client.ts:30` only allows `node.importKind === "type"`.
   - `tools/oxlint/ditzy/rules/no-server-runtime-imports-in-client.test.ts:48` marks `import { type ConversationAction } ...` invalid.
   - `import { type X }` is erased at runtime and should be allowed.
   - Remedy: allow the import when all specifiers are type-only; update the test.
   - Related: `no-runtime-imports-in-shared` also reports type-only imports; confirm whether that policy is intentional and align rule name/docs.

4. **Medium — duplicate prompt schema**
   - `src/shared/contract/conversation-schema.ts:17` (`participantPrompt`)
   - `src/shared/contract/character-library.ts:19` (`characterPrompt`)
   - Same five fields. Remedy: extract one canonical prompt schema and reuse.

5. **Medium — `src/server/contract/conversation.ts` is 798 lines and mixes concerns**
   - Route wiring, SSE stream mechanics (`createGenerationSubscriptionResponse`), error mapping, and projections all live in one file.
   - Remedy: extract `generation-sse.ts` and `generation-error-mapping.ts`; leave the route file as wiring only.

6. **Medium — sibling generation route still duplicates the acceptance skeleton**
   - `src/server/contract/conversation.ts` around the `/sibling/generations` route.
   - `generationAcceptanceRoute` was extracted for Send/Continue, but sibling still repeats `acceptedGenerationBody` + `generationStartFailure` + status mapping.
   - Remedy: widen the factory or extract a shared failure-response mapper and use it for all three acceptance routes.

7. **Medium — `no-hand-written-wire-guards` is threshold-based and misses a real case**
   - `tools/oxlint/ditzy/rules/no-hand-written-wire-guards.ts` flags only functions with >= 4 guard calls.
   - `src/client/chat-history.ts:137` still hand-decodes the 410 cleaned-up body with `isRow`.
   - Remedy: use `Value.Decode(importCleanedUpResponse, value)` there; rework the rule to detect the actual decoder pattern.

8. **Low — architecture-enforcement machinery overlap**
   - `scripts/check-contract-ownership.ts` (301 lines) has hard-failure coverage that overlaps with the oxlint rule; its unique value is advisory shape-match warnings.
   - Decide/document whether this script is the hard gate or the advisory layer.

9. **Low — `src/shared/contract/wire.ts` mutates TypeBox global `FormatRegistry` on import**
   - Idempotent today, but shared contract modules should be data, not global side effects.
   - Consider initializing the format in app entrypoints or accept and document loudly.

10. **Minor — docs typo**
    - `docs/architecture-enforcement.md` says “five project rules” then “The four rules are fully enforced.”

## Next actions for a fresh agent

- Apply the three high findings first (cycle, schema-derived types, oxlint inline type-only import handling).
- Then extract the conversation route file and finish the acceptance-route dedup.
- Re-run `bun run lint && bun run lint:rules && bun run check:contracts && bun run typecheck && bun run typecheck:tools && bun run test` after changes.
- Do not re-derive the full diff in this document; use `git diff origin/master...HEAD` and the commit messages above.
