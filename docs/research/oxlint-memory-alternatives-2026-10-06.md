# Oxlint RuleTester allocation failure and alternatives

Research date: 2026-10-06

Research used Exa Agent and Exa page retrieval, upstream source/issues, official tool documentation, and read-only inspection of this checkout. No dependencies, configuration, application code, or Windows memory settings were changed for this research. No workaround or migration was executed.

## Diagnosis

The installed `oxlint` and `@oxlint/plugins` versions are 1.87.0. Its RuleTester allocates 6,442,450,928 bytes, approximately 6 GiB, before parsing the first snippet. The allocation guarantees room for a roughly 2 GiB block whose starting address is aligned to 4 GiB. The snippet itself does not need 6 GiB. This is explicit in [upstream parse.ts](https://github.com/oxc-project/oxc/blob/main/apps/oxlint/src-js/package/parse.ts) and matches the installed `node_modules/oxlint/dist/plugins-dev.js`, lines 66-107, and constants in `dist/lint.js`.

The buffer is initialized once and reused within that module instance. It is not a fresh 6 GiB allocation for every test case. Separate processes or module instances can multiply the requirement.

Windows commit headroom is the likely immediate cause of the reported failure. A read-only snapshot during this investigation showed 38,877,818,880 committed bytes against a 39,783,211,008-byte limit, about 0.84 GiB remaining. That is well below the single buffer request. [Microsoft documents](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/introduction-to-the-page-file) the commit limit as RAM plus pagefiles and explains why allocations can fail near that limit. This snapshot supports the diagnosis; it is not a fresh reproduction of the original failure.

The upstream [Windows raw-transfer report #23759](https://github.com/oxc-project/oxc/issues/23759) describes the same JavaScript buffer allocation failing under Windows commit pressure. That issue concerns `oxc-parser`, a sibling implementation, and was closed as a duplicate, not as evidence of a released RuleTester fix.

## Upstream fix status

The native linter's Rust allocator already has a Windows fix, [PR #22124](https://github.com/oxc-project/oxc/pull/22124). It uses `VirtualAlloc` to reserve address space separately from committing pages, starting with only 16 KiB committed. That does not fix RuleTester's JavaScript-owned `ArrayBuffer`.

[PR #26741](https://github.com/oxc-project/oxc/pull/26741) addresses RuleTester directly by moving buffer ownership into Rust and exposing the resulting memory to JavaScript. Exa returned it as open on this research date. Its author reports passing Node/Bun tests but explicitly says the Windows path was read, not tested. It is a relevant proposed fix, not a verified Windows fix or an available fix in installed 1.87.0. The inspected upstream `main` still contains the JavaScript allocation.

## Workarounds

1. **Run the existing RuleTester suite on Linux or WSL.** This avoids the Windows allocation accounting involved here while exercising Oxlint's actual parser and rule runtime. An Oxlint maintainer recommends WSL in [#19395](https://github.com/oxc-project/oxc/issues/19395), although that discussion originally concerns the native allocator. The inference to this RuleTester failure is supported by the shared allocation mechanism and #23759. It still needs a run of this repository's suite. Use Linux Node and Linux-installed dependencies inside WSL, not the Windows native bindings. The checkout currently has an Ubuntu workflow running `bun run check`, which includes `lint:rules`; this investigation did not verify a successful CI run.
2. **Provide more Windows commit headroom.** Closing memory-heavy applications or enlarging a constrained pagefile can allow the allocation. Aim for more than 6 GiB free plus room for the rest of the process. This is a resource workaround, not a reduction in Oxlint's buffer size. No pagefile settings were changed.
3. **Use ESLint's tester for custom-rule tests.** This avoids Oxlint's RuleTester allocation when paired with `@typescript-eslint/parser`. It changes which engine is tested, so it does not establish that the same cases work under Oxlint. Details and migration costs follow below.

Flags and substitutions that do not address this allocation:

- `--max-old-space-size` controls V8 old-space heap capacity, not the Windows commit limit or this fixed backing-store request. Increasing it is not a targeted fix. See [Node CLI documentation](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib).
- `--test-isolation=none` is already in this repository's script. Sharing a process can avoid duplicate buffers, but the first buffer still needs approximately 6 GiB.
- `oxlint --threads 1` can reduce native linter concurrency. It does not configure the separate `node --test` RuleTester allocation.
- Node 24 and 26 both reach the same allocation. The installed tester rejects Node before 22 and explicitly rejects Bun. Switching to Bun is not a workaround for this release, even though the application itself uses Bun.
- `experimentalRawTransfer: false` is an option in the sibling `oxc-parser` reproduction. The inspected RuleTester parser always uses raw transfer; that option is not an established RuleTester escape hatch.
- No buffer-size option was found in the inspected implementation or documentation. Editing only the size constant would violate the alignment and fixed-offset assumptions.

## Recommendation

For the smallest operational change, keep Oxlint and run its rule suite on Linux while tracking #26741. For reliable native-Windows development, first trial `@typescript-eslint/rule-tester` against the existing custom rules. If Windows is the required development environment, I favor moving custom-rule execution and tests together to ESLint so that tests exercise the engine actually enforcing the policy.

A hybrid can keep Oxlint's built-in rules and put custom rules plus their tests in ESLint. It needs two configurations; disable overlapping checks to avoid duplicate diagnostics. A full move to ESLint gives one engine and is the closest API fit for these custom rules. Replacing native Oxlint coverage also requires mapping its enabled built-in rules and defaults. No repository performance comparison was run.

Biome plugins and ast-grep are poor replacements for the complete rule set. They are plausible for small, syntax-only policies, but cannot express the repo's scope resolution and multi-step TypeScript type-shape analysis in their documented declarative plugin APIs.

## What this repo's rules need

The local rules are already ESLint-shaped and mostly written against Oxlint's defineRule types. For example, no-layer-dependencies-in-shared checks import nodes and file paths, which is a direct syntax-rule port. no-known-value-widening does substantially more: it queries scope variables and references, follows stable const bindings, unwraps TypeScript assertions and satisfies, inspects annotations, and builds a type environment from the Program. A replacement based only on structural matching would mean redesigning that rule rather than translating it.

Oxlint documents eslintCompatPlugin as adding an ESLint create method that delegates to the plugin's createOnce, making the same plugin usable by Oxlint or ESLint. Its custom-JS-plugin page says the API is in alpha and calls out limitations, including no type-aware rules. The current repo's most complex example appears syntactic and AST based rather than checker-backed, but depends on scope analysis and TypeScript AST nodes. Confirm the wrapper supports the exact APIs before relying on it in ESLint tests.

## Options

| Option | Fit for this repo | Main cost or caveat |
| --- | --- | --- |
| ESLint + typescript-eslint for custom rules and tests | Best API fit. Official docs support authoring ESLint rules over TypeScript with @typescript-eslint/parser, recommend @typescript-eslint/utils, and provide @typescript-eslint/rule-tester. This path does not use Oxlint's raw-transfer allocation. | Adds dependencies and requires translating test configuration and expected positions. General memory use and this repo's compatibility remain unmeasured. |
| Hybrid: Oxlint native lint + ESLint custom rules/tests | Best minimal experiment. Keep Oxlint's existing native lint pass; invoke ESLint only for local custom rules or tests. Rules already using eslintCompatPlugin may work in both, according to Oxlint's documentation. | Two config formats and possible duplicate diagnostics. Oxlint JS plugin support is documented as alpha; verify the exact plugin and version behavior. |
| Biome GritQL plugins | Useful for simple declarative patterns and rewrites. The documented API matches code patterns and registers diagnostics, with optional rewrite suggestions. | Not a general TypeScript/JavaScript callback API. The docs describe a narrow API centered on register_diagnostic; it does not match rules using scope references, variable resolution, or an in-memory type environment. |
| ast-grep YAML rules | Useful for fixed AST patterns, relational constraints, and simple rewrites. Built-in tests support valid/invalid snippets and snapshots. | Rule logic is declarative matching over AST nodes. The documented model does not provide callbacks or scope/type-checker services; rules such as no-known-value-widening would need to be split or stay in ESLint/Oxlint. |

## Practical path

For an ESLint trial, use the existing plugin export's wrapped `rules[name]`, or port the rule to ordinary ESLint `create(context)`. Importing a bare `createOnce` rule does not run the plugin-level wrapper. Use `@typescript-eslint/parser` even for syntax-only rules because the snippets contain TypeScript. Checker-backed `projectService` is only needed if rules request TypeScript type information; the inspected rules do not.

The test migration is not just an import change. Replace Oxlint's `parserOptions.lang` configuration, bind the tester's Node test hooks, and translate expected diagnostic columns. Oxlint documents zero-based test columns; ESLint's tester uses one-based columns. Existing tests include `column: 0`. Check AST and scope behavior on the complex rules. Also resolve package compatibility explicitly: this repo declares TypeScript 7 and a separate TypeScript 5 alias, so do not assume any chosen typescript-eslint release accepts the root compiler version. The official [dependency page](https://typescript-eslint.io/users/dependency-versions/) did not render a usable TypeScript version range during this research.

A tests-only switch leaves Oxlint runtime behavior untested by that suite. Keep the Oxlint suite on Linux if retaining Oxlint execution, or move both execution and tests to ESLint for a single custom-rule engine. The existing `eslintCompatPlugin` is a documented interop API, not a new compatibility layer proposed by this report. A complete ESLint replacement can remove Oxlint-specific wrappers and types.

A fuller ESLint migration should only follow if the isolated tester works and the team wants one rule runtime. Replacing Oxlint with Biome or ast-grep would require redesigning a meaningful part of the policy set, especially the widening/evidence rules.

## Sources

- ESLint, [Custom rules](https://eslint.org/docs/latest/extend/custom-rules). Documents rule structure and built-in RuleTester.
- typescript-eslint, [Building custom rules](https://typescript-eslint.io/developers/custom-rules/). Documents TypeScript-compatible custom rules, @typescript-eslint/utils, and its RuleTester recommendation.
- typescript-eslint, [Rule Tester](https://typescript-eslint.io/packages/rule-tester/). Documents test setup for untyped and type-aware rules.
- Oxlint, [Writing JS plugins](https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html). Documents eslintCompatPlugin, its ESLint behavior, and custom rule testing.
- Oxlint, [JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html). Documents plugin compatibility status and supported API areas, plus unsupported TypeScript type-aware rules.
- Biome, [Linter plugins](https://biomejs.dev/linter/plugins/). Documents GritQL matching, diagnostics, rewrites, and plugin API.
- Biome, [GritQL reference](https://biomejs.dev/reference/gritql/). Notes active work and missing/unfinished GritQL features.
- ast-grep, [Lint rules](https://ast-grep.github.io/guide/project/lint-rule.html). Documents declarative YAML matching and fixes.
- ast-grep, [Test your rule](https://ast-grep.github.io/guide/test-rule.html). Documents valid/invalid fixtures and diagnostic snapshots.

