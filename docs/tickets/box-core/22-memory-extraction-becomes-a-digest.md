# Memory extraction becomes a digest

Status: TODO

Blocked By: 20-memory-settings-become-box-data, 21-digests-read-the-chat

Source: GitHub #68 "Extraction → `digest`" and "Collections → Variant records".

## Goal

Memory supplies `digest(window) → claims` and nothing else for extraction. Its claims live in `box:memory` record slots on each Variant. Memory's worker loop, `work_epoch` cancellation, sync, catch-up runs and the `memory_collection` table are deleted, and the host's digest queue does their work.

## Decisions

- Memory declares `records` with a claims-array record schema, and `records.digest` with a window of 4. It trims the window to its token budget inside `run`. `run` makes the extraction call through `ctx.llm` and judges through `ctx.decide`, as `src/server/memory/extraction.ts` does today.
- Memory declares `decision`. Its Decision selection moves from the settings that ticket 20 moved to the host's per-Box selection (`src/server/box/decision-settings.ts`). Recall and extraction both use it.
- A passage by an excluded author digests to an empty record.
- Recall reads effective records (`writer ?? automatic`). A candidate's identity is `messageId:variantId:claimIndex` plus a hash of the effective record. The activation record schema replaces `ownership` and `collectionRevision` with `writer: boolean`.
- Editing or removing a claim writes the whole claims array as the Writer record, through the generic `set-box-record` command.
- **Behavior change from #68:** reset drops the Writer record, so the automatic claims come back. Re-extraction happens only when the source hash changes.
- Label merges and Cast identities apply when claims are rendered and recalled, not by rewriting stored claims. Label commands stop touching records, and `revision`/`label_revision` bumps go.
- `memory_embedding_cache` stays. It is a cache keyed by text, not collection state. The digest embeds the claims it produces, and recall embeds any claim text missing from the cache (Writer edits). `index_attempt_json` and the per-collection readiness go.
- The failed-source counts in the activation state come from slot `error`s (ticket 21).
- **Behavior change:** the per-Variant extraction pipeline trace (`trace_json`, its route in `src/server/contract/memory.ts` and its view in `MemorySource.tsx`) is removed. Status and failure come from the record slot.
- Memory's catch-up UI uses the host catch-up route and progress.

## Work

- [ ] Declare Memory's `records`, `digest` and `decision`, and move extraction into `digest.run`.
- [ ] Point recall, the Memories panel, claim edits and reset at record slots.
- [ ] Apply labels at read time and simplify the label commands.
- [ ] Delete `collections.ts`, `work.ts`, `cancellation.ts`, `sync.ts`, the Memory call in `app.ts`, `memory_collection`, `memory_catchup_run` and the pipeline trace.
- [ ] Rewrite the unit tests that query `memory_collection` directly against record slots, keeping only those that pin behavior. Delete tautological ones.
- [ ] `e2e/memory.spec.ts`, `e2e/box-lifecycle.spec.ts` and `e2e/story-jump.spec.ts` pass, apart from the reset change.
- [ ] Update `docs/box-system/README.md`: Memory is the second digest consumer with records and Writer overrides.
- [ ] Run `bun run check` and the full `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- `memory_collection` and `memory_catchup_run` are gone, and no Memory code schedules, polls or cancels its own work.
- No host file under `src/server/box/` changed to accommodate Memory specifically.
