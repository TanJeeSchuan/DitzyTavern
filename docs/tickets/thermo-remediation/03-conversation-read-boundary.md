# Conversation read boundary

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, the conversation portion of F7 and finding F11.

## Goal

Make conversation reads follow the raw `Database` public-entry policy and finish the shared read-model query and grouping helpers.

## Ownership

- `src/server/conversation/index.ts`
- Conversation read helpers in `src/server/conversation/**`
- `src/server/conversation/history.ts`
- `src/server/conversation/snapshot.ts`
- `src/server/conversation/generation-details.ts`
- `src/server/conversation/internal.ts`
- `src/server/contract/conversation.ts`
- Focused conversation and contract tests

Do not edit `src/server/conversation/commands/accept-generation.ts` or `src/server/workflows/generate.ts`. Ticket 05 owns those files.

## Work

- [x] Change public read helpers to accept the raw `Database` and connect internally.
- [x] Stop reconnecting the database in every read lambda in the conversation facade.
- [x] Bind the conversation module once in the conversation contract route.
- [x] Extract module-internal helpers for active-cast reads and variants-by-message grouping.
- [x] Replace the duplicate history and snapshot query/grouping paths with those helpers.
- [x] Keep query behavior, ordering, and returned shapes unchanged.
- [x] Remove obsolete helper paths without compatibility layers.
- [x] Run focused history, snapshot, generation-details, contract, and conversation tests, typechecking, and the full test suite.
- [ ] Run `/code-review` with Luna XHigh review subagents and resolve its findings.
- [x] Set this ticket to DONE and commit the implementation.

## Acceptance

- Conversation read entry points follow the same raw `Database` policy as commands.
- Contract routes do not repeat `withDatabase` module construction.
- Active-cast and variant-grouping query scaffolding each have one implementation.
