# T10: Guardrails against the debt round 5 removed

Status: DONE

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
- [x] Slices b, c and d, one PR

## Acceptance

`bun run check` runs knip, the clone check, the new rules and the stylesheet step, and passes on master. Each new rule's test shows it refusing the pattern it names and accepting the allowlisted case.

## Outcome

### Slice a

In [PR #293](https://github.com/TanJeeSchuan/DitzyTavern/pull/293), `bun run check` runs Knip's production scan, a scan that includes tooling and the browser harness, and the jscpd baseline. The baseline records the existing cloned ranges by file and token. It accepts surviving subranges after deletions, line shifts and CRLF checkouts, and detects new ranges and changes inside literals. `bun run check:clones` still writes the full jscpd report.

The Knip triage removed unused internal exports, type aliases and helpers and made same-file declarations private, including the unused Oxlint dictionary helper. The network-free Model Client lives in test fixtures. The Macro Variables workflow test sets initial values through the production edit command. Box version tests inspect the installed version folders directly. Existing cross-module test consumers of live production code have symbol-specific exceptions. The existing `@ai-sdk/provider` import now has a direct dependency, and the stream preview uses the declared Playwright package.

Knip findings kept

- Box SDK exports `useBoxStatus`, `BoxExport`, `boxSdkVersion`, `ParticipantId`, `CodeAgentFunction`, `CodeAgentValue` (kept surface).
- None of the flagged contract schemas was dead code. Each one backs a live route in its own module. The orchestrator removed `export` from the 15 that nothing outside their module imports, and deleted the 3 unused type aliases `ChatImportReceiptParticipant`, `ImportDetailsArtifactAvailability` and `MemoryRelevanceScore`. The rest stay exported because tests or `scripts/profile-actions.ts` import them. Nothing here is surface for the owner to decide.

The Box host loads the built-in Box default exports by folder. Knip allowlists those live entry exports by name.

Both Knip scans, the clone check and focused tests passed. Probes verified that production Knip rejects a module reachable only from the browser harness, and that the scans flag unused named Box and tooling exports and an unreferenced script. The clone regression test covers deletion, shorter surviving ranges, JSX indentation, CRLF and a replacement that changes literal text. GitHub Check runs the full suite and e2e. Slices b, c and d remain open.

### Slices b, c and d

The five Oxlint rules catch rename-only declarations, re-export-only modules, raw server fetches, direct Box hook calls, and direct Drizzle writes to Conversation tables. Existing exceptions are listed next to their reasons. Creator Mode scenarios now share the setup refusal guard with Chat commands. The regression test verifies the scenario diagnostic when a setup hook throws.

The stylesheet step checks cross-file custom property declarations and rejects Tailwind's OS-driven `dark:` variant. It records the runtime properties supplied by Radix Select and SwipeBrowser. Both checks run from `bun run check`.
