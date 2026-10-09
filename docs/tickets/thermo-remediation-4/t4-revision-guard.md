# T4 — One optimistic-revision guard, one Stale error

Status: DONE

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

- [x] Inventory every guard site and every `Stale*Error` throw/catch (`grep -rn 'Stale[A-Za-z]*Error' src`)
- [x] Introduce `guardRevision` + `StaleRevisionError` (test it through one real module, not in isolation)
- [x] Migrate module by module: connection-settings, revisioned-settings users, prompt-preset, lorebook library, lorebook attachments, character-library, memory collections/labels, conversation
- [x] Collapse `presentDomainError` to the one class; delete the `recover*Conflict` presenters
- [x] typecheck, lint, check:contracts, `bun run test`
- [x] Commit (one commit per module migration is fine)

## Acceptance

`grep -rhoE 'class Stale[A-Za-z]+Error' src/server | sort -u | wc -l` is 1 (2 only if Conversation must keep its own, justified in Outcome).
`grep -rn 'recover[A-Za-z]*Conflict' src` is empty.

## Outcome

- **One class:** `StaleRevisionError` in the new `src/server/revision.ts`, with `guardRevision(aggregate, expectedRevision, row, current)`.
  Acceptance count is 1; Conversation keeps no error class of its own.
- **Guard shape vs. the sketch:** every guarded module must already read its row first, because row *absence* is each module's own
  typed not-found (unchanged wire), and the conflict's `current` is a per-aggregate projected read (a settings snapshot with Profiles,
  a Prompt Preset summary with the deletion impact, a full Lorebook, a Character snapshot, a Collection view, a summary — not the raw
  row). The guard therefore takes the already-read row plus a `current` reader (evaluated only on the stale path) instead of `db, table, id`;
  `createRevisionedSettings` and the settings-module commits ride it exactly as the "narrow" sketch would.
- **One envelope per aggregate in one place:** the class builds its wire `details` via a closed switch (`staleRevisionDetails`) over
  `RevisionAggregate` (`settings` / `preset` / `lorebook` / `lore-attachment` / `character` / `conversation` / `generation` /
  `memories` / `collection`), matching each route family's declared 409 schema, so `presentDomainError` needed no change at all:
  it already presents any outcome-carrying error with details, and `recover*` (`contract/domain-error-recovery.ts`) plus the
  recover parameter are deleted outright.
- **Route-time re-reads became throw-time reads:** the three aggregates that re-read at route level for recovery (`conversation`,
  `memories`, `lore-attachment`) now read their authoritative `current` inside the failing transaction's guard call. Nothing has been
  written before those guards fire, so the values (and every asserted test payload) are identical; the "conversation disappeared
  during recovery → not-found" branch could no longer fire (the row is held inside the read transaction) and its test went away with
  the presenter that owned it.
- **Generation keeps its prose envelope:** the `409` schemas of the generation-start families accept only `{ outcome, reason }`
  (reason = the error message), while Conversation command routes carry the full conflict. One aggregate key cannot express both route
  families, so the generation-surface throws use the `generation` aggregate — same class, prose envelope. This is why the aggregate
  is a naming for the wire envelope, not just the domain table.
- **Conversation kept its bump, not a guard:** the shared seam owns the compare-and-throw everywhere, including the two Conversation
  pre-check call sites; `advanceConversationRevisionGuarded` is retained because it is the *advance* — one conditional UPDATE that
  mirrors `last_message_time` into the same statement and, on the acceptance seams, reports a caller-owned post-write revision
  (`expectedRevision + 1`) that a read-and-compare guard cannot produce (`conversation/commands/transaction.ts`). The observer hook
  (`runConversationTransaction` → `observeConversationWrites`) is untouched by the guard and never ran through it anyway.
- **Memory label commands moved:** `setMemoryIdentity` / `mergeMemoryLabels` (and their shared `rewriteCollections`) moved from
  `memory/labels.ts` to `memory/collections.ts`, because their conflict envelope carries `readConversationMemories` — living beside it
  removes what would otherwise be an import cycle, and the label state itself is still read through the labels seam.
- **Gates:** `bun run typecheck`, `bun run lint`, `bun run check:contracts` clean everywhere except pre-existing notes in committed
  `src/client/story/prose.tsx` (outside this ticket); `bun test src` passes (1297 tests, 0 fail). Note: `src/client` files visible modified
  in this worktree belong to the concurrent T9/T10 client threads; no T4 edit touched them.
