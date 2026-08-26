# `tokenx` for prompt token approximation

Research date: 2026-08-26. This note covers `tokenx` 2.1.0, the latest npm release on that date. Sources are limited to the npm registry and the package's official repository.

## Recommendation

`tokenx` is a good fit for DitzyTavern's fast, deterministic prompt estimate and oldest-whole-message trimming pass, with two conditions:

1. Treat the result as an estimate, never an exact provider token count.
2. Put a configurable safety policy around it and still handle a provider context-limit rejection cleanly.

It is not strong enough to prove that an arbitrary OpenRouter or OpenAI-compatible request fits a model's context window. The default rules are calibrated only against OpenAI's `o200k_base`. The package does not account for chat-message wrappers, role tokens, tool definitions, attachments, or any other provider-side serialization. Its own documentation also names severe underestimation cases, including about 70% for high-entropy strings and 30% to 60% for several unsupported scripts. A universal 10% padding would therefore be false confidence. [README accuracy scope and exceptions](https://github.com/johannschopplich/tokenx/blob/v2.1.0/README.md#benchmarks)

For the current Generation design, use `estimateTokenCount` on every textual field that the Prompt Plan compiler will send, then add any provider-adapter framing allowance separately. Recompute the complete candidate plan after removing each oldest whole Message. Do not use `sliceByTokens` or `splitByTokens` for history trimming because the agreed policy keeps Message boundaries intact. Keep the estimated input, reserved output budget, and safety allowance as separate values in prompt inspection.

Before choosing the safety allowance, benchmark representative DitzyTavern prompts against every supported provider or model tokenizer that can expose an exact count. RP prose, dialogue, character cards, JSON-like examples, multilingual text, emoji, and long IDs should all be in the corpus. Store actual usage returned after Generation separately from the preflight estimate.

## What the package does

The public ESM API exports four synchronous functions and two option types: [public implementation](https://github.com/johannschopplich/tokenx/blob/v2.1.0/src/index.ts), [type declarations](https://github.com/johannschopplich/tokenx/blob/v2.1.0/src/types.ts).

| API | Behavior relevant to DitzyTavern |
| --- | --- |
| `estimateTokenCount(text?, options?)` | Returns an integer estimate and returns `0` for missing or empty text. |
| `isWithinTokenLimit(text, limit, options?)` | Checks `estimateTokenCount(...) <= limit`. It inherits every approximation limitation. |
| `sliceByTokens(text, start?, end?, options?)` | Maps estimated token positions back to character positions. It does not find real tokenizer boundaries. Negative indices cause a full buffered walk. |
| `splitByTokens(text, tokensPerChunk, options?)` | Splits on the estimator's segments. The target is not a hard maximum, and one long segment can make a chunk exceed it. |

`TokenEstimationOptions` has only:

- `defaultCharsPerToken`, which defaults to 7;
- `languageConfigs`, an array of `{ pattern: RegExp, averageCharsPerToken: number }`.

There is no model argument, tokenizer registry, provider adapter, or async loading step. Supplying `languageConfigs` replaces the built-in accent, Cyrillic, Greek, and emoji configurations rather than extending that array. Custom patterns run before the separate CJK rule, so they can override CJK estimates. [option resolution and rule order](https://github.com/johannschopplich/tokenx/blob/v2.1.0/src/segments.ts)

The implementation splits text around whitespace and punctuation, then applies hand-tuned ratios. It has special rules for structured whitespace, digit runs, short lowercase ASCII words, punctuation, accented European text, Cyrillic, Greek, emoji, Hanzi, Kana, and Hangul. It rounds per segment, so estimates are not guaranteed to be additive across independently counted prompt blocks. Counting the final compiled representation is safer than summing cached block estimates. [estimation rules](https://github.com/johannschopplich/tokenx/blob/v2.1.0/src/segments.ts)

The options are not validated. A zero or negative character ratio can yield nonsensical results. DitzyTavern should own and validate any calibration configuration rather than accepting raw values from a client.

## Runtime and package shape

The library build is ESM-only. The package has `"type": "module"`, exports `dist/index.mjs`, marks itself side-effect-free, and declares no runtime dependencies. It does not declare a Node `engines` range. The separately shipped CLI imports `node:process`, but the library entry imports no Node built-ins. [package manifest](https://github.com/johannschopplich/tokenx/blob/v2.1.0/package.json), [library source](https://github.com/johannschopplich/tokenx/blob/v2.1.0/src/index.ts), [CLI entry](https://github.com/johannschopplich/tokenx/blob/v2.1.0/src/cli/entry.ts)

This package shape suits DitzyTavern's Bun server. I also executed the published `dist/index.mjs` with the workspace's Bun runtime and with Node; both imported it and returned `4` for `"Hello, world!"`. The root library should also bundle for modern browsers because it uses only JavaScript and Web-standard language features. Browser compatibility is not an explicit package guarantee, and the Unicode property escape used for emoji requires a modern JavaScript engine. Keep token-budget authority server-side even if the client uses the same estimator for a live preview.

The npm 2.1.0 metadata reports:

- MIT license;
- zero declared runtime dependencies;
- 7 published files;
- 66,954 bytes unpacked;
- a 20,002-byte `.tgz` in the downloaded registry artifact;
- npm provenance attestations;
- one maintainer in the registry metadata.

The published library file `dist/index.mjs` is 7,886 bytes before compression in the downloaded artifact. The project's "2kB bundle" claim appears to use a compressed or minified bundle metric, but the README does not define it. The practical bundle cost is still small. [npm registry metadata](https://registry.npmjs.org/tokenx/2.1.0), [published package](https://www.npmjs.com/package/tokenx)

## Model and language coverage

Version 2.1.0 calibrates every built-in ratio against `o200k_base`, using `gpt-tokenizer` only as a development benchmark dependency. The shipped package contains heuristics, not tokenizer tables. The author explicitly warns that other LLM families will differ and suggests tuning `defaultCharsPerToken` and `languageConfigs`, or using a full tokenizer when exact counts matter. [README introduction](https://github.com/johannschopplich/tokenx/blob/v2.1.0/README.md#tokenx), [development manifest](https://github.com/johannschopplich/tokenx/blob/v2.1.0/package.json)

Built-in handling covers:

- ordinary ASCII prose, numbers, punctuation, and code-like segmentation;
- accented German, French, Spanish, and some Slavic text;
- Cyrillic and Greek patterns;
- simplified contemporary Chinese calibration plus Japanese and Korean rules;
- emoji runs.

Known weak cases in the package's own README are important for an RP application:

| Content | Reported direction and approximate error |
| --- | --- |
| Base64, hashes, and digests | Underestimates by about 70% |
| Traditional or classical Chinese | Underestimates by about 10% to 20% |
| Arabic | Underestimates by about 35% |
| Hindi | Underestimates by about 30% |
| Hebrew | Underestimates by about 45% |
| Thai | Underestimates by about 60% |

Custom language rules can reduce script-specific error, but there is no automatic language or model selection. [documented exceptions](https://github.com/johannschopplich/tokenx/blob/v2.1.0/README.md#benchmarks)

## Accuracy claim, in context

The advertised "95%+ average accuracy" means mean absolute percentage deviation below 5% on nine repository fixtures measured against `gpt-tokenizer/encoding/o200k_base`. CI also requires every one of those samples to stay below 10% deviation. The published chart currently reports 3.60% mean absolute deviation, with individual signed errors from -7.30% to +5.89%. [benchmark tests](https://github.com/johannschopplich/tokenx/blob/v2.1.0/test/accuracy.test.ts), [fixture list and thresholds](https://github.com/johannschopplich/tokenx/blob/v2.1.0/test/fixtures/samples.ts), [published chart](https://github.com/johannschopplich/tokenx/blob/v2.1.0/docs/bench.md)

The benchmark corpus is small but varied. It includes English chat, an API response, TypeScript source, English documentation and prose, German prose, and Japanese, Korean, and Chinese articles. Those samples fed back into calibration. A separate three-document holdout covers French prose, imperative English, and Russian text. CI gives each holdout sample a looser 15% deviation bound. [holdout test and rationale](https://github.com/johannschopplich/tokenx/blob/v2.1.0/test/holdout.test.ts)

These tests are better than an unsupported marketing percentage, but they do not establish 95% accuracy for every prompt, tokenizer, model, or language. They measure text tokenization only. They also use document-scale fixtures, while a Prompt Plan mixes many short blocks whose per-segment rounding and provider framing may change the error profile.

## Maintenance and release risk

The package is active as of the research date. npm records 13 published versions under the current package name, with 1.3.0 in January 2026 and six releases from 1.4.0 through 2.1.0 between July 27 and August 5, 2026. Version 2.0.0 was a breaking release that removed a deprecated alias and substantially recalibrated the estimator. Version 2.1.0 added the CLI. [npm version history](https://registry.npmjs.org/tokenx), [2.0.0 release](https://github.com/johannschopplich/tokenx/releases/tag/v2.0.0), [2.1.0 release](https://github.com/johannschopplich/tokenx/releases/tag/v2.1.0)

The concentrated recalibration work is reassuring for current accuracy but means estimates can shift after package upgrades. Pin the dependency with the existing lockfile, record the estimator version in diagnostics if estimates become persisted provenance, and rerun a DitzyTavern calibration corpus before upgrading. The API is small enough that replacing the package later would be cheap if it sits behind a project-owned `TokenEstimator` interface.

## Proposed integration boundary

Keep `tokenx` behind a server-owned estimator with a contract shaped around policy rather than the package API:

```ts
interface PromptTokenEstimate {
  estimatedInputTokens: number
  reservedOutputTokens: number
  safetyAllowanceTokens: number
  estimator: 'tokenx'
  estimatorVersion: string
  calibrationProfile: string
}
```

The Prompt Plan compiler should remain responsible for what enters the request and which whole Messages may be dropped. The estimator should only count a supplied representation. That keeps provider serialization, trimming order, and the meaning of the latest Human-authored Message out of a third-party heuristic library.

For the first implementation:

1. Compile the fixed prompt blocks and selected history.
2. Estimate all provider-facing text and add the adapter's framing allowance.
3. Compare `estimate + reserved output + safety allowance` with the configured context window.
4. Drop the oldest whole history Message and recompute until it fits.
5. Reject with an inspectable size breakdown if fixed blocks plus the protected latest Human-authored Message still exceed the budget.
6. If the provider still rejects the request for context length, preserve the Human-authored Message and expose the mismatch. Do not retry automatically.

This gives DitzyTavern the speed and small dependency cost that make `tokenx` attractive without pretending that a heuristic for one tokenizer is a provider guarantee.
