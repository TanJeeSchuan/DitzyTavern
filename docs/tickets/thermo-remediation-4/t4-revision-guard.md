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
- [x] Review fix round 1: payload-discriminated constructor/guard arguments, collection guards, label-command split, lorebook dispatcher hoist

## Acceptance

`grep -rhoE 'class Stale[A-Za-z]+Error' src/server | sort -u | wc -l` is 1 (2 only if Conversation must keep its own, justified in Outcome).
`grep -rn 'recover[A-Za-z]*Conflict' src` is empty.

## Outcome

- **One class:** `StaleRevisionError` in the new `src/server/revision.ts`; `CurrentByAggregate` maps each aggregate to exactly its
  409 payload (`generation` maps to `undefined`), and the constructor/`guardRevision` argument tuples are derived from that map, so a
  wrong payload or a missing state-bearing payload is a type error at every call site. Acceptance count is 1; Conversation keeps no
  error class of its own.
- **Guard shape vs. the sketch:** every guarded module must already read its row first, because row *absence* is each module's own
  typed not-found (unchanged wire), and the conflict's `current` is a per-aggregate projected read (a settings snapshot with Profiles,
  a Prompt Preset summary with the deletion impact, a full Lorebook, a Character snapshot, a Collection view, a summary — not the raw
  row). The guard therefore takes the already-read row plus a `current` reader (evaluated only on the stale path) instead of `db, table, id`;
  `createRevisionedSettings` and the settings-module commits ride it exactly as the "narrow" sketch would.
- **One envelope per aggregate in one place:** the class builds its wire `details` through one flat `staleRevisionDetails` switch over
  the discriminated constructor args (`settings` / `preset` / `lorebook` / `lore-attachment` / `character` / `conversation` /
  `generation` / `memories` / `collection`), matching each route family's declared 409 schema, so `presentDomainError` needed no
  change at all: it already presents any outcome-carrying error with details, and `recover*` (`contract/domain-error-recovery.ts`)
  plus the recover parameter are deleted outright.
- **Route-time re-reads became throw-time reads:** the three aggregates that re-read at route level for recovery (`conversation`,
  `memories`, `lore-attachment`) now read their authoritative `current` inside the failing transaction's guard call. Nothing has been
  written before those guards fire, so the values (and every asserted test payload) are identical; the "conversation disappeared
  during recovery → not-found" branch could no longer fire (the row is held inside the read transaction) and its test went away with
  the presenter that owned it.
- **Generation keeps its prose envelope:** the `409` schemas of the generation-start families accept only `{ outcome, reason }`
  (reason = the error message), while Conversation command routes carry the full conflict. One aggregate key cannot express both route
  families, so the generation-surface throws use the `generation` aggregate — same class, prose envelope. This is why the aggregate
  is a naming for the wire envelope, not just the domain table.
- **Conversation kept its advance, not a guard:** the shared seam owns every read-and-compare guard site, including the two
  Conversation pre-check call sites. The compare-and-throw is **not** fully shared: four sites keep their own compare because the
  guard cannot express them — `advanceConversationRevisionGuarded` and `advanceCharacterRevision` are conditional-UPDATE advances
  (the Conversation one mirrors `last_message_time` into the same statement and, on the acceptance seams, reports a caller-owned
  post-write revision of `expectedRevision + 1`), reset keeps its absent-row branch (`actualRevision = expectedRevision + 1`, an
  unprocessed view), and `replaceDiscoveryCatalog` compares the revision together with its `models_url` precondition. The observer
  hook (`runConversationTransaction` → `observeConversationWrites`) is untouched by the guard and never ran through it anyway.
- **Memory label commands moved:** `setMemoryIdentity` / `mergeMemoryLabels` (and their shared `rewriteCollections`) now live in
  `memory/label-commands.ts`, above both seams they read (`labels` for the label state, `collections` for the authoritative
  `readConversationMemories` their conflicts carry). Appending them to `memory/collections.ts` had grown it 579 → 631 lines; the
  commands now sit in their own 90-line module and `collections.ts` is 559 lines. The barrel and every importer (the memory route
  plus four contract tests) point at the new module.
- **Review fix round 1:**
  - `revision.ts` links payloads to aggregates (`CurrentByAggregate`) and derives the discriminated constructor/guard arguments from
    it; `staleRevisionDetails` is one flat switch with no `current as StaleRevisionCurrent` cast; `revisioned-settings` is constrained
    to `CurrentByAggregate["settings"]`; `requireConversationRevision` branches "generation" (no payload) from "conversation" (summary
    payload). Verified with a throwaway `src/server/revision.typecheck-probe.ts` holding positive calls and `@ts-expect-error` cases for
    a wrong payload, a missing payload, and a payload on "generation": typecheck clean, probe not committed.
  - `correctMemorySource` / `retryMemorySourceIndex` now call `guardRevision("collection", …)`; reset routes its existing-row compare
    through it while keeping its source-availability (`!selected` / empty content) and absent-row (`expectedRevision + 1`, unprocessed
    view) throws verbatim.
  - `executeLorebookCommand` guards once before the switch and bumps once after the five mutating cases, so each case performs only
    its mutation; `create` does not guard, and `duplicate` and `delete` guard but genuinely do not bump. Position/renumber logic is
    untouched.
  - Character Lore-attachment advance re-reads the owner state and throws not-found when it vanished, so the required
    `LorebookOwnerAttachmentState` payload is always present (the branch is unreachable inside the already-guarding transaction).
- **Gates:** round 1 re-verified: `bun run typecheck` exit 0; `bun run lint` exits 0 (warnings only, pre-existing); `bun run check:contracts` exits 0
  (11 pre-existing suspicious cross-layer matches); `bun test src/server/contract` 369 pass / 0 fail; `bun test src/server/memory` 7 pass / 0 fail;
  `bun test src/server/lorebook` 24 pass / 0 fail; `bun test src/server` 1017 pass / 0 fail. A concurrent-client `src/client/lib/eden.ts`
  error appeared and cleared mid-round; no T4-owned path had a type error.

### Review round 2 (orchestrator fix)

- `guardRevision` takes one rest-tuple union derived from `CurrentByAggregate` instead of a generic overload, so a union-typed
  aggregate (`"settings" | "lorebook"`) or an explicit union type argument can no longer pair a payload with the wrong aggregate.
  Probe (deleted): union aggregate, wrong payload, missing reader, and reader on `generation` all fail typecheck; the internal
  constructor-tuple assertion is now sound under the public signature.
