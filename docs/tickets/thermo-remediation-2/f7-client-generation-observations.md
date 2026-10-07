# `client/story.ts` has four generation actions with one body

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F7.

## Goal

Collapse the four generation story actions — `generation-state`, `generation-content-delta`, `generation-reasoning`, `generation-reasoning-delta` — which shared one guard and one `updateStoryVariant` body shape, into a single `generation-observed` action, and delete the dead non-delta reasoning variant.

## Mechanics

**Machinery removed**

- All four action variants and all four reducer cases in `src/client/story.ts` (three near-identical cases plus the dead `generation-reasoning` non-delta variant — a full-repo producer search confirmed it had no producer anywhere).
- The three-way switch in `generationSessionStoryAction` (`src/client/workspace/useGenerationController.ts`), including its dead `StoryAction | null` return that made every call site guard against an impossible null.

**Machinery introduced**

- One `generation-observed` action type, discriminated on `mode`:
  - `mode: "replace"` carries the authoritative snapshot's `content` + `reasoning` pair. The wire snapshot carries both fields under one event id, so it replaces both accumulated fields atomically.
  - `mode: "append"` carries `{ stream: "content" | "reasoning", mode: "append", text }`, mirroring the wire delta payloads verbatim.
- One reducer case under the same `acceptsGenerationObservation` guard; `generationSessionStoryAction` collapses to one shared `{ messageId, variantId, generationId, eventId }` construction plus one branch, returning a non-null `StoryAction`.

**Design note**

The brief's flat `{ stream, mode, text }` single-payload shape cannot preserve behavior: the wire snapshot replaces `content` and `reasoning` together under one event id. Two single-field observations would make the second fail the strict `eventId > lastEventId` guard, and relaxing the guard for replaces would change stale-snapshot race semantics (snapshots currently rejected as stale would be accepted). The union on `mode` is the minimal encoding that keeps one action type, one dispatch site, a 1:1 effect→action mapping, and the uniform strict guard.

**Behavior**

None. Same guard, same field outcomes, same wire payloads (server-side generation streaming is outside this ticket). Every producer and consumer moved in the same commit; no alias for the old action names remains anywhere in `src/`.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` — exit 0 (all warnings pre-existing, none in touched files).
- `bun run test` — 1304 pass / 0 fail.
- `rg "generation-state|generation-content-delta|generation-reasoning-delta|'generation-reasoning'" src/client src/shared` — no matches; `generation-observed` appears in exactly one action type, one reducer case, one dispatch site.
- File-size guard: `story.ts` 527, `story.test.ts` 778, `useGenerationController.ts` 355 lines.
- `bunx playwright test e2e/generation.spec.ts` — 10 passed (scripted provider fakes unchanged; streaming, stop, swipe, error, and Prompt Plan flows green).

## Residual (accepted)

- Pre-existing file-size violations outside this ticket's scope (e.g. `src/styles/story.css`, 1232 lines) are untouched; this branch introduces no file ≥ 1,000 lines.
