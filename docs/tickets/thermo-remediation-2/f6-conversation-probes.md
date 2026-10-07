# The Conversation existence/revision probe reads one shared helper

Status: DONE

Blocked By: None

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`,
finding F6, with the folded F13 fragment (the duplicated `max(position)`).

## Goal

The hand-written `select({ id: conversationTable.id })…get()` probe existed
at ten-plus sites, each re-deciding whether a missing Conversation throws or
returns `undefined`, where the stale-revision check lives, and how the
Drizzle handle is obtained. `execute.ts` additionally kept a verbatim copy
of `ensureConversationRevision`, and Tail/Continuation acceptance read
`max(messages.position)` twice in one transaction. After this ticket the
probe pattern exists exactly once per shape, the revision prelude exists
once, and the provisional target's position is derived from the validation
read instead of being re-probed.

## Mechanics

**Machinery removed**

- `ensureConversationRevision` in `accept-generation.ts` (the module-local
  revision prelude) and the verbatim prelude copy in
  `executeConversationCommandWithResult` — both call the shared
  `requireConversationRevision` now, in the same reject order
  (not-found first, then stale) with the same typed errors.
- Ten hand-written probe preludes:
  `accept-generation.ts` (Sibling existence), `active-generation.ts`
  (stop-all existence), `selected-history.ts`, `generation-details.ts`,
  `generation-settings.ts` (undefined-returning reads),
  `lorebook/attachments.ts`'s two Character-owned/eligibility reads
  (`readLorebookAttachmentState`, `readParticipantLorebookAttachments`),
  `execute.ts`'s prelude, plus the two snapshot.ts narrow probes
  (`conversationExists`, `readConversationRevision`) that re-queried the
  same row — they now read the shared probe.
- The mid-transaction reconnect in the Active-Generation gate: `execute.ts`
  and `accept-generation.ts` called the reconnecting `hasActiveGeneration`
  from inside open transactions. The inner
  `hasActiveGenerationFromConnection` takes the open connection; the
  reconnecting wrapper stays only as the public entry point (delete.ts's
  pre-transaction gate and the workflows seam in `conversation/index.ts`).
- The duplicated `max(position)` read (folded F13):
  `createProvisionalModelTarget`'s `input.position ?? re-read max(position)`
  fallback is gone. Each lifecycle's `validate` now returns the position the
  provisional model target takes — one past the Human Message it just
  inserted for Tail (`(latestPosition ?? 0) + 2`), one past the terminal
  model Message for Continuation — and `position` is required input.
  `AcceptGenerationValidation.position` and
  `ProvisionalModelTargetInput.position` lost their optional markers.
- Scaffolding: unused `GenerationJsonValue` import in `internal.ts`, unused
  `ConversationMemoryChange` import in `active-generation.ts`, and the
  never-used `reportChange` transaction parameter in
  `acceptConversationSiblingGeneration`.

**Machinery introduced**

- `conversation/internal.ts`, one probe query written once:
  `findConversation(db, id)` — the `{ id, revision }` projection, `undefined`
  when the row is gone; `requireConversation(db, id)` — the typed
  `ConversationNotFoundError` throw on top of it;
  `requireConversationRevision(db, id, expected)` — the shared revision
  prelude (existence, then the stale check) on top of `requireConversation`.
  Type-shape note: the undefined-returning sites (selected-history,
  generation-details, generation-settings, the two Lorebook reads) cannot
  take a throwing helper without changing what their routes present as
  not-found, so the probe ships in both shapes with one underlying query.
- `hasActiveGenerationFromConnection(db, id)` alongside the thin raw-Database
  `hasActiveGeneration(database, id)` wrapper. The wrapper keeps the module's
  raw-Database entry policy (no caller constructs the module's Drizzle
  handle); in-transaction gates stop reconnecting.

**Behavior**

None intended and none observed: same errors, same reject order, same
connection boundaries, same positions, same change reports. The full suite
is identical to base (1303 pass / 0 fail). The only sweep-visible deltas are
the deleted duplicates.

## memory/labels.ts import-direction decision

The probe in `memory/labels.ts` (`mergeMemoryLabels`) is **left in place**.
Two independent reasons:

1. **The F1 contract forbids the import.** Converting the probe means
   importing from `conversation/internal` — server `memory` currently
   imports nothing from server `conversation`, and
   `shared/contract/conversation-memory-change.ts` states the settlement
   explicitly: "Neither module imports the other; this shared declaration is
   the only shared vocabulary." Re-opening memory → conversation coupling
   for one probe would undo the F1 remediation, and hoisting the probe (plus
   `ConversationNotFoundError`) into `shared/` for a single caller is a
   redesign this finding does not authorize.
2. **The error shape differs.** The probe throws a plain
   `Error("This Chat no longer exists.")`, not
   `ConversationNotFoundError("Conversation N was not found.")`; converting
   it would change the surfaced failure of `mergeMemoryLabels` for one
   branch. "Behavior: none" wins.

If Memory ever needs the shared probe, the move is the F1 way: a shared
vocabulary declaration, not a module-to-module import.

## Out-of-scope remainders (inspected, not converted)

- `database/teardown.ts:44` — probes its own teardown targets before
  deleting them; not a Conversation-owned command prelude. Untouched.
- `sillytavern/prior-imports.ts:103` — selects `{ id, name }` for import
  mapping, a different probe shape in a module this ticket does not own.
  Untouched.
- `src/client/**`, `src/server/workflows/**`, `src/server/application/**`
  are exclusion zones of this finding and were not touched.

## Verification

- `bun run typecheck` — exit 0.
- `bun run lint` — exit 0; 36 warnings, identical count to base, zero in the
  files this ticket touched. `bun run lint:rules`, `bun run typecheck:tools`
  — exit 0.
- `bun run test` — 1303 pass / 0 fail (base: 1303 / 0).
- `bun run check:contracts` — exit 0; identical output to base except one
  more structural declaration (the `ConversationProbe` interface) and the
  same 11 suspicious cross-layer matches as base (no new ones).
- `bun run test:e2e` — 33 passed + 1 flake (`updates.spec.ts:55` server
  restart timing); the flake passes on re-run and is unrelated to this
  change.
- `rg -nU 'select\(\{\s*id: conversationTable\.id' src/server | rg -v test` —
  the shared helper in `internal.ts` plus the three documented remainders
  above. `rg -n 'ensureConversationRevision' src/server` — zero matches.
- `rg --files src -0 -g '*.ts' -g '*.tsx' | xargs -0 wc -l` — no production
  file reaches 1000 lines (largest: 998, a pre-existing test file).
