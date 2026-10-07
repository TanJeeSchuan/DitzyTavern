# Memory decoupling from Conversation write transactions

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, finding F1.

## Goal

Remove feature logic (Memory sync) from the deep Conversation module's write transactions, and remove the conversation → memory → conversation import cycle.

## Mechanics

**Machinery removed**

- All 12 `db.$client` escape-hatch calls to Memory from inside Conversation command handlers and `conversation/delete.ts`.
- The raw-SQL registered-variant sweep in `memory/sync.ts` (`abandonMemoryWorkForRemovedVariants`); removed Variants are now named in the report instead of re-discovered by scanning Conversation's `message_variant` table.
- The `memory/collections.ts` import of `readSelectedHistory` — the conversation → memory → conversation cycle is gone in both directions.

**Machinery introduced**

- `shared/contract/conversation-memory-change.ts` — `ConversationMemoryChange` (`{ conversationId, touchedVariantIds, removedVariantIds, promptPresetChanged }`), the single shared vocabulary. Neither module imports the other.
- `runConversationTransaction` now hands each write a transaction-scoped `reportChange(change)`; reporting twice throws. The application layer installs one observer (`observeConversationWrites` in `app.ts`), and it runs as the **last statement of the same immediate transaction wrapper**, so Memory reads exactly the state the write commits — identical ordering to the per-handler calls it replaces.
- `memory/sync.ts` applies the reported change: abort in-flight work for removed Variants, invalidate stale sources and re-queue selected ones for touched Variants, full refresh on Prompt Preset change.

**Behavior**

None. The provider-visible and wire-visible ordering is unchanged; e2e fakes are untouched. Direct composition callers (contract tests) install the same observer in their test composition, matching `app.ts`.

## Verification

- `bun run typecheck` — clean; `bun run lint` — exit 0; `bun run check:contracts` — exit 0.
- `bun test src` — 1283 pass / 0 fail.
- `rg -c 'db.$client' src/server/conversation/` — 0 matches.

## Residual (accepted)

Memory still *reads* Conversation-owned rows (`message_variant`, `active_generation`, `messages`) via drizzle for capture, catch-up, and the touched-variant staleness join — one-way access through the shared schema, no escape hatch and no module-import cycle. Full inversion of those reads belongs to a later finding.
