# T4 — One optimistic-revision guard, one Stale error

Status: TODO

Blocked By: T1, T2

Source: issue #52, finding **F4** (blocker). The biggest removal in the round (≈400 lines, 9 classes).

## Problem

Each module hand-rolls "read revision → compare → bump → throw Stale":
`conversation/commands/transaction.ts` (`advanceConversationRevisionGuarded`), `connection-settings/index.ts` (`revisionedWrite`),
`revisioned-settings.ts` (`createRevisionedSettings`, used by memory + semantic settings), `prompt-preset/library.ts`,
`lorebook/library.ts` (`requireCurrentRevision` + `incrementRevision` repeated in every `executeLorebookCommand` case),
`lorebook/attachments.ts` (`advanceCharacterRevision`), `character-library/execute.ts`, `memory/collections.ts` / `labels.ts`.

Ten error classes: `StaleSettingsError` (`revisioned-settings.ts:14`), `StaleMemoryLabelsError` (`memory/labels.ts:20`),
`StaleMemoryCollectionError` + `StaleMemorySettingsError` (`memory/collections.ts`), `StaleConversationRevisionError`
(`conversation/errors.ts`), `StaleConnectionSettingsRevisionError`, `StalePromptPresetRevisionError`,
`StaleCharacterRevisionError`, `StaleLorebookRevisionError`, `StaleLoreAttachmentOwnerRevisionError`.
`presentDomainError` (`contract/domain-error.ts`) plus per-module `recover*Conflict` presenters
(`contract/domain-error-recovery.ts`, `contract/conversation.ts`, `contract/lorebook-routes.ts`, `contract/memory.ts`)
map each class back to the one shared `conflict` envelope.

## Files owned

Every file above, their `errors.ts` siblings, `src/server/contract/domain-error*.ts`, and tests that name the removed classes.

## Mechanics

- **Remove:** 5 of the 6 guard implementations, 9 of the 10 error classes, the per-module `recover*Conflict` presenters.
- **Introduce:** one `guardRevision(db, table, id, expected)` (or generalise `createRevisionedSettings`, which already proves the
  shape for two modules) that returns the bumped row or throws a single
  `StaleRevisionError { aggregate, expectedRevision, actualRevision, current }`. `presentDomainError` matches that one class.
- **Conversation:** keeps its own guard only if its observer hook (`observeConversationWrites`) cannot ride the shared one.
  If it can, remove that too. Record which in the Outcome, with the reason.
- **Behavior changed:** none on the wire. The conflict payloads already share one shape; existing contract tests must pass unchanged
  except for imports and class names.

## Rejected

- A base class the ten errors extend: keeps ten classes and ten presenters (the "attendance sheet" AGENTS.md forbids).

## TODO

- [ ] Inventory every guard site and every `Stale*Error` throw/catch (`grep -rn 'Stale[A-Za-z]*Error' src`)
- [ ] Introduce `guardRevision` + `StaleRevisionError` (test it through one real module, not in isolation)
- [ ] Migrate module by module: connection-settings, revisioned-settings users, prompt-preset, lorebook library, lorebook attachments, character-library, memory collections/labels, conversation (if possible)
- [ ] Collapse `presentDomainError` to the one class; delete the `recover*Conflict` presenters
- [ ] typecheck, lint, check:contracts, `bun run test`
- [ ] Commit (one commit per module migration is fine)

## Acceptance

`grep -rhoE 'class Stale[A-Za-z]+Error' src/server | sort -u | wc -l` is 1 (2 only if Conversation must keep its own, justified in Outcome).
`grep -rn 'recover[A-Za-z]*Conflict' src` is empty.

## Outcome
