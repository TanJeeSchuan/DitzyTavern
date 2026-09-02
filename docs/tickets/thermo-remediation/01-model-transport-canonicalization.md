# Model transport canonicalization

Status: TODO

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, findings F4, F6, and F12.

## Goal

Make the shared chat-completions transport own its vocabulary and usage helpers. Remove the misleading DeepSeek-specific module name.

## Ownership

- `src/shared/generation-json.ts`
- `src/server/conversation/types.ts`
- `src/server/model-client/deepseek.ts`, including its rename
- `src/server/model-client/**` import sites and tests needed by the rename
- `src/server/workflows/generate-server-owned.ts`
- Direct import sites required to complete the rename

Do not edit the generation lifecycle bodies in `src/server/workflows/generate.ts` or acceptance commands. Ticket 05 owns those changes.

## Work

- [ ] Replace the hand-written `GenerationRequestValue` and `GenerationRequestOverrides` vocabulary with aliases or re-exports from `src/shared/generation-json.ts`.
- [ ] Give `normalizeUsage` and `addUsage` one owner in the model-client layer and remove the duplicate workflow implementation.
- [ ] Rename `deepseek.ts` to `chat-completions.ts` and update all production and test imports.
- [ ] Remove obsolete paths. Do not leave a compatibility re-export at `deepseek.ts`.
- [ ] Preserve behavior for DeepSeek, OpenAI-compatible, and OpenRouter adapters.
- [ ] Run focused model-client and workflow tests, typechecking, and the full test suite.
- [ ] Run `/code-review` with Luna XHigh review subagents and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- There is one canonical generation JSON vocabulary.
- There is one implementation of the usage normalization and addition helpers.
- No source import refers to `model-client/deepseek`.
- All three adapters still use the shared chat-completions transport.

