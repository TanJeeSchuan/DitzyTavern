# Decision Models over the System One wire

Status: TODO

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

- [ ] Add the System One API Format to Connection Profiles with positive-timeout validation, the OpenRouter Decisions, TypeSafe and blank presets, and `systemone` URL resolution.
- [ ] Build the Decision Model client: selection resolution (endpoint, optional Bearer credential, custom headers, profile timeout as deadline), packing with the selection's state token limit, and lenient parsing with exact answer and option keys.
- [ ] Add Test Connection for System One profiles: one `noul` question on state `"ping"`, parsed by the production parser.
- [ ] Add the decision selection, state token limit and retain probability minimum to Memory Settings, and replace the usefulness confidence gate. Accept only System One profiles.
- [ ] Move Memory extraction judgment onto the Memory selection. Fail a source whose state exceeds the limit. Gate admission on the `retain` probability. Keep confidence only when returned.
- [ ] Move Memory recall onto the Memory selection, trim the scene to the limit, and replace the Jev fields in the Memory Activation Record and Generation Details.
- [ ] Replace Typesafe Settings with Semantic Trigger Settings (profile, model, state token limit, threshold; no profile means off) and new routes. Chunk the scene to the selection's limit.
- [ ] Put both selections, their limits and the threshold into the preparation fingerprint and capture revision.
- [ ] Drop the Typesafe settings table and add the new table and columns through a generated migration.
- [ ] Replace the Typesafe Jev entry in Connections with a Semantic Triggers entry, add the Decision Model controls to Memory Settings, and rename Jev copy that means the role.
- [ ] Delete the Typesafe module, routes, editor, client settings and hardcoded endpoint.
- [ ] Switch the E2E fake to recognise `/systemone` calls, and the Jev fixture to create and select a System One profile.
- [ ] Add the contract tests in spec Testing Decisions 2–5. Verify the UI manually with playwright-cli.
- [ ] Update the conversation-memory and lorebooks specs, README files and AGENTS.md wording.
- [ ] Run focused tests, typechecking, the full test suite and `bun run test:e2e`.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- An OpenRouter Decisions profile judges Memory with Jev and Semantic Triggers with Clef Flash in the same installation, using one key.
- A blank System One profile pointed at a keyless local server sends no Authorization header and passes Test Connection.
- A Decision Model selection with a 2,000-token state limit splits a long Lore Scan Window into chunks, trims the recall scene, and fails an oversized extraction source visibly.
- Memory admission ignores `confidence` and uses the `retain` probability minimum.
- Clearing the Semantic Trigger selection produces keyword-only matching with the existing explanation.
- No code path, setting or route mentions Typesafe except the TypeSafe preset.
