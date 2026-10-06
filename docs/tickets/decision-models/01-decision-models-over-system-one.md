# Decision Models over the System One wire

Status: DONE

Blocked By: None

Source: `docs/specs/decision-models.md`, all User Stories, Implementation Decisions and Testing Decisions; ADR-0044, ADR-0047.

## Goal

Replace the Typesafe-only Jev integration with Decision Models reached through System One Connection Profiles, chosen separately by Memory and by Semantic Triggers, and remove Typesafe Settings.

## Ownership

- Connection Profile contract, validation, presets, URL resolution and Test Connection
- The Typesafe module, replaced by one Decision Model client
- Memory Settings, Memory extraction judgment and Memory recall
- Lore semantic evaluation, its settings record and routes
- Generation preparation fingerprint and capture
- Database schema and a generated migration
- Connections, Memory Settings and Generation Details UI
- E2E fake, fixtures and Memory and Lore specs
- `docs/specs/conversation-memory.md`, `docs/specs/lorebooks.md`, README files, AGENTS.md

## Work

- [x] Add the System One API Format to Connection Profiles with positive-timeout validation, the OpenRouter Decisions, TypeSafe and blank presets, and `systemone` URL resolution.
- [x] Build the Decision Model client: selection resolution (endpoint, optional Bearer credential, custom headers, profile timeout as deadline), packing with the selection's state token limit, and lenient parsing with exact answer and option keys.
- [x] Add Test Connection for System One profiles: one `noul` question on state `"ping"`, parsed by the production parser.
- [x] Add the decision selection, state token limit and retain probability minimum to Memory Settings, and replace the usefulness confidence gate. Accept only System One profiles.
- [x] Move Memory extraction judgment onto the Memory selection. Fail a source whose state exceeds the limit. Gate admission on the `retain` probability. Keep confidence only when returned.
- [x] Move Memory recall onto the Memory selection, trim the scene to the limit, and replace the Jev fields in the Memory Activation Record and Generation Details.
- [x] Replace Typesafe Settings with Semantic Trigger Settings (profile, model, state token limit, threshold; no profile means off) and new routes. Chunk the scene to the selection's limit.
- [x] Put both selections, their limits and the threshold into the preparation fingerprint and capture revision.
- [x] Drop the Typesafe settings table and add the new table and columns through a generated migration.
- [x] Replace the Typesafe Jev entry in Connections with a Semantic Triggers entry, add the Decision Model controls to Memory Settings, and rename Jev copy that means the role.
- [x] Delete the Typesafe module, routes, editor, client settings and hardcoded endpoint.
- [x] Switch the E2E fake to recognise `/systemone` calls, and the Jev fixture to create and select a System One profile.
- [x] Add the contract tests in spec Testing Decisions 2â€“5. Verify the UI manually with playwright-cli.
- [x] Update the conversation-memory and lorebooks specs, README files and AGENTS.md wording.
- [x] Run focused tests, typechecking, the full test suite and `bun run test:e2e`.
- [x] Run `/code-review` and resolve its findings.
- [x] Set this ticket to DONE and commit the implementation.

## Acceptance

- An OpenRouter Decisions profile judges Memory with Jev and Semantic Triggers with Clef Flash in the same installation, using one key.
- A blank System One profile pointed at a keyless local server sends no Authorization header and passes Test Connection.
- A Decision Model selection with a 2,000-token state limit splits a long Lore Scan Window into chunks, trims the recall scene, and fails an oversized extraction source visibly.
- Memory admission ignores `confidence` and uses the `retain` probability minimum.
- Clearing the Semantic Trigger selection produces keyword-only matching with the existing explanation.
- No code path, setting or route mentions Typesafe except the TypeSafe preset.

## Verification

- Typecheck passed; full unit suite: 1,235 passed; E2E: 21 passed; E2E harness: 3 passed.
- After the final review cleanup, typecheck, 30 focused tests and all 3 harness tests passed again.
- Manual playwright-cli verification covered Connections, System One profile editing and resolved URL, filtered model pickers, independent Memory and Semantic Trigger selections, state limits, thresholds, clearing Semantic Triggers, and desktop/narrow layouts.
- Opus 5.5 high reviewed Standards and Spec independently. The first implementation review was completed. Integration review round 1 supersedes its agreement to retain vendor-specific fixture names.
- No spec decisions were skipped. The integration branch tip was merged before final validation; it was already included.

### Integration review round 1

- Findings 1–3: removed response type coercion, separated invalid JSON from invalid answer fields with question/field paths, and excluded extraction settings from recall freshness. Contract tests were written first and observed failing before each behavior fix. Boolean and string `noul` answers fail; a missing `ping/noul` field identifies the failure; changing retain admission preserves an inspected plan with one recall request.
- Findings 4–5: removed the duplicate positive-timeout check while retaining format validation; absent confidence renders no bar.
- Findings 6–10: removed fingerprint-shape, exact-error-copy and binary-search-step assertions; replaced picker booleans with `apiFormat`; shared Decision Model controls and preset menus; resolution now calls the same selection validation used by both settings modules. Memory's `checkChoice` already handles only extraction and embeddings. Both snapshot callers share `tryResolveDecisionSelection` and `decision`/`unavailableReason`; the semantic snapshot keeps only `triggerThreshold`.
- Finding 11: retained the selection in recall freshness. Fixing finding 3 required removing the all-settings revision, since an extraction-only apply increments it. The selection is now necessary, alongside recall relevance and enabled state. Model and state-limit changes still invalidate inspected plans.
- Findings 12–15: packed requests carry their original questions into response validation; E2E fixtures, rules, routes and copy use the Decision Model role while vendor model IDs remain unchanged; Test Connection and database defaults share the state-limit constant; removed the unused settings read and reused `configureDecisionModels`.
- Finding 16 skipped under its size condition. Machinery removed by the proposal: compact format-label, URL-resolver, default-timeout and deletion-copy expressions. Machinery introduced: three records with four facts each, a supported-format type, imports and lookup consumers. Behavior changed: none. The map and its imports exceed the compact expressions removed; the writing-eligibility and format-specific branches would still remain.
- Merged the current `decision-models-system-one` tip, `180cfca`; Git reported already up to date. `bun run check` passed: lint, lint rules, contract ownership, application/tool typechecks, 1,242 unit tests and 3 E2E harness tests. `bun run test:e2e` passed all 21 tests. The first E2E run exposed a composer-readiness race in Lore; reused the existing `send` helper and the complete rerun passed.
- Manual browser verification covered the shared preset menu, System One-only model selection and clearing in both Memory and Semantic Trigger editors. Screenshots were inspected.
