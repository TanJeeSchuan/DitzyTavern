# T10: Guardrails against the debt round 5 removed

Status: IN PROGRESS

Blocked By: T8

Model: Sol 6.2 high. Reviewer: Sonnet 5.5 high.

T2, T4 and T5 deleted dead exports, barrels, rename-only aliases, unreachable CSS and duplicated declarations, and T1 fixed bugs that came from a second copy of a guarded call. Each kind below is mechanical, so it gets a check in `bun run check` (`scripts/run-check.ts`) instead of a line in `CODING_STANDARDS.md`. Run after T8 so the first knip triage runs on the smaller codebase.

New lint rules go in `tools/oxlint/ditzy/rules/` with a `.test.ts` beside each, run by `bun run lint:rules`. Every rule ships with the codebase passing it: fix or allowlist each existing hit in the same slice, with the reason next to the allowlist entry.

Slice a ships alone, since its triage deletes code and raises surface to the owner. Slices b, c and d ship as one PR: each adds a check, fixes or allowlists its hits, and wires it into `check`.

## Slice a: dead code

- **knip.** Add `knip` and a `knip.json`. Entry points: the server and client entries, `scripts/`, `e2e/`, `tools/`, and `src/box-sdk/*.ts`, so the Box SDK's exports count as used (README "Kept surface"). Run `knip --production` in `check`, so code only tests use is reported too. Triage the first report: delete internal code; raise anything that is surface (CODING_STANDARDS "Removing code") to the owner instead of deleting it.
- **Clones.** `check:clones` (`jscpd src`, configured in `.jscpd.json`) exists and nothing runs it. Record today's clones as a baseline and fail `check` only on clones beyond it.

## Slice b: declaration shape

- `ditzy/no-type-alias-rename`: refuse `type A = B` where `B` is a bare type reference with no type arguments, and `export { a as b }`. Catches T2a's rename-only aliases and the `AcceptedGenerationRecord` alias T4b removed.
- `ditzy/no-reexport-module`: refuse a module whose only statements are `export … from`. Exempt `src/box-sdk/`. Catches `shared/generation-json.ts` and the barrels T2a removed.

## Slice c: one home for guarded calls

- `ditzy/no-raw-server-fetch`: refuse the global `fetch` in `src/server` outside `model-client/model-fetch.ts`. Allowlist `box/sandboxed-deps.ts`, which sets `redirect: "error"`, and whatever T9 leaves in `authoring/provider.ts`. Bug 4 was a second fetch path without the shared policy.
- `ditzy/no-unguarded-box-hook`: refuse calling a Box descriptor hook (`setupError` first; extend to the others the host wraps in `box/registry.ts`) outside the module that owns its guard (`boxSetupRefusal` in `box/setup.ts`, and `registry.ts`, `sandboxed.ts`). Known hit: `authoring/scenario.ts` calls `box.setupError` directly; route it through `boxSetupRefusal`. Bug 7 was an unguarded copy of a guarded call.
- Conversation writes: check whether `ditzy/no-manual-conversation-transaction` refuses a direct Drizzle `update`/`insert`/`delete` on a Conversation table outside `src/server/conversation/`. If it does not, add a rule that does. Bug 8 was a paint preset write outside the dispatcher.

## Slice d: stylesheets

One script step in `check`:

- Collect every custom property declared (`--name:`) across `src/**/*.css`, and fail on a `var(--x)` with no declaration and no fallback. Bug 9 was `var(--input)`.
- Fail on any `dark:` utility in `src`. Tailwind 4's built-in `dark` variant follows the OS colour scheme, not `data-theme`, so after T2b one compiles and quietly follows the wrong setting.

## Rejected

- Writing these as `CODING_STANDARDS.md` rules. They are mechanical; the reviewer is for judgement.
- A check for unreachable CSS selectors. Nothing deterministic is reliable here; it stays with review.
- Checks for "a parameter every caller passes is required" and "a stage passes its input along". They need call-site and type information; they stay in `CODING_STANDARDS.md`.

## TODO

- [x] Slice a, PR (knip triage findings that are surface raised to the owner)
- [ ] Slices b, c and d, one PR

## Acceptance

`bun run check` runs knip, the clone check, the new rules and the stylesheet step, and passes on master. Each new rule's test shows it refusing the pattern it names and accepting the allowlisted case.

## Outcome

### Slice a

`bun run check` now runs production Knip and `bun run check:clones`. The jscpd baseline records 77 clone occurrences by file pair and fragment fingerprint. New occurrences fail the check even when an old clone disappears. The Knip triage removed unused internal exports, type aliases and helpers. Box version and macro state tests now construct or inspect their fixtures directly. Existing test consumers of production exports have symbol-specific exceptions in `knip.json`.

Knip findings kept for owner review

- Box metadata schema re-export `boxMetadataSchema`.
- Generation inspection fields `effectiveGenerationSettings` and `LoreActivationRecord`.
- Macro Variable command and stored write declarations `macroValue`, `macroVariableName`, `macroVariableWrite` and `MacroVariablesEditBody`.
- Prompt Preset response types `SillyTavernImportApplied`, `PromptPresetListResponse` and `PromptPresetConflict`.
- Chat import receipt and artifact types `ChatImportReceiptParticipant` and `ImportDetailsArtifactAvailability`.
- Memory trace type `MemoryRelevanceScore` and the Memory Settings schema aliases `memorySettings` and `memorySettingsResponse`.

Production Knip and the clone check passed on the slice. A temporary module imported only by its test failed Knip, and a temporary pair of identical functions failed the clone check. All eight focused Box version and macro state tests passed. The GitHub Check workflow runs the full suite and e2e. Slices b, c and d remain open.
