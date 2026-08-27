# 03 — Preserve SillyTavern Swipes and generation provenance

**What to build:** Extend the complete import path to preserve the full SillyTavern rescue-export shape. Every source Swipe becomes an ordered native Variant, the exact saved Swipe remains selected, Variant and Conversation chronology are derived consistently, and agreed generation provenance is promoted without losing the canonical raw source. Structurally invalid sources fail atomically, while unusual valid state and deliberate duplicate imports remain supported.

**Blocked by:** 02 — Import a payload-only SillyTavern Chat end to end.

**Status:** resolved

- [x] Records with Swipes derive native content and promoted metadata exclusively from `swipes` and corresponding `swipe_info`; duplicated top-level assistant payload is not promoted.
- [x] Every Swipe remains a distinct Variant in source order, including empty and duplicate-text alternatives, and exactly `swipe_id` is selected.
- [x] Variant timestamps use source alternative timestamps, Message time is the earliest owned Variant time, Chat creation time is the earliest Message time, and Chat activity time is the latest Variant time.
- [x] Promoted Variant metadata includes source Swipe index, provider/API, model, generation ID, generation timing and outcome diagnostics, reasoning, and reasoning signatures when present.
- [x] Blank captured author names remain blank and produce a warning; unknown source fields are ignored by the projection but remain value-lossless in the canonical archive.
- [x] Invalid JSON, missing required content, invalid timestamps, out-of-range selection, or mismatched Swipe arrays abort the entire import.
- [x] Re-importing the same source is allowed, creates a new Chat ID, retains the same source UUID and hash, and warns about matching prior imports.
- [x] Focused synthetic tests cover representative Swipe fidelity and one structural rollback case without exhaustively testing optional fields.
- [x] A local smoke check against the untracked rescue export verifies 833 Messages, 1,624 Variants, exact selected state, timestamp bounds, raw archive persistence, report persistence, and a readable Conversation snapshot.

## Comments

- `adapter.ts` now branches on record shape: a record without `swipes` keeps the ticket-02 payload-only path (one selected Variant, row-level provenance attached when the row carries it), while a record with a `swipes` array produces one Variant per Swipe in source order, selecting exactly `swipe_id`.
- Swipe records require `swipe_info` as an array of exactly `swipes.length`; each entry supplies the Variant timestamp (`send_date`, falling back to the row `send_date` when the entry omits it) and the promoted provenance. Swipe content must be strings; `swipe_id` must be an integer in range; entry `send_date`/`gen_started`/`gen_finished` must be valid timestamps when present. Any violation aborts the import.
- Message time is the earliest timestamp among its own Variants (so selection changes can never move a Message); Chat creation and activity times were already derived by the generic creation seam from Message times and all Variant times.
- Promoted Variant metadata lives in the transitional `import.sillytavern` namespace as `variant.*` keys: swipe index, api, model, generation id, generation started/finished, generation duration, time to first token, finish reason, reasoning duration/type/text, reasoning signature. Only present, non-empty, non-null source values are promoted; the duplicated top-level assistant payload (`mes`, row `extra`, row `gen_*`) is never promoted.
- Fixtures gained `swipeRecordFixture` (4 Swipes incl. duplicate text and an empty alternative, full per-Swipe `swipe_info`, poisoned row-level duplicates) and `provenancedPayloadFixture` (row-level provenance on a payload-only record).
- 42 synthetic tests (up from 31): Swipe ordering/selection/timestamps, provenance promotion and exclusion of row-level duplicates, empty-selected Swipe, payload-only provenance, mismatched/missing `swipe_info`, out-of-range `swipe_id`, non-string Swipes, invalid Swipe timestamps, end-to-end Swipe import with derived chronology, and one mismatched-array atomic rollback case.
- Importer version bumped to `0.2.0` since the projection now models Swipes.
- Smoke check (ephemeral, untracked export `test_data/rescue-1787063924075.jsonl`, in-memory DB): 833 Messages, 1,624 Variants, exactly one selected Variant per Message with all 418 selected positions/content matching `swipes[swipe_id]` (including the final Message's empty selected Swipe), all 1,624 Variant timestamps matching `swipe_info` `send_date`, Message times at their earliest Variant time, chat creation 2026-08-08T12:53:02.008Z and activity 2026-08-18T14:38:11.119Z, raw archive with header + 833 records, report persistence, revision 0, and a readable identical snapshot. Lint and typecheck clean; full suite green.
