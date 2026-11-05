# Cross-version checks

Status: Done

Blocked By: 04 (Box versions), and saving each full `run_scenario` input in the session log

Source: the Creator Mode scope discussion of 2026-11-05.

## Goal

An author learns, before Install, of the incompatibilities its own scenarios can reach, instead of from a writer's refused Update. Compatibility between versions stays the author's responsibility. The host only reports, and never migrates stored data.

## Design decisions already made

- **Records and Moves are a permanent log across versions.** A new version may add shapes, never change what an old shape means. Everything else follows [`record` and `records`](../../box-system/README.md#record-and-records). `contract.md` gains this rule and the translate-on-read pattern: one object record schema in which the old fields stay as declared but become optional, the new fields are added as optional, and an optional `v` tags records the new version writes; the fold converts any record without `v` through one adapter function. Nothing in the contract changes. The pattern does not apply to a digesting Box: its passage timeline edits records and refuses optional fields (`src/client/box-windows/PassageTimeline.tsx:61`), so such a Box may only widen the fields it already has (more literals in a choice, a wider number range), never add one. Letting the timeline edit optional fields is outside this ticket.
- **`run_scenario({ ..., from: <version> })`** runs turns `1..k` on the earlier version, applies ticket 04's upgrade check to the data they left, then runs the remaining turns on the candidate, folding the earlier records. A refusal reads exactly as the writer's Update would.
- **State diff.** The same run also folds the earlier version's records with both versions' folds and reports the difference. It is information, not a failure: a version may change state on purpose. It surfaces the changes no schema can see, such as a field that meant "3 more" now read as "3 total".
- **Install checks against `latest`.** When the Box already has a version, Install replays the session's saved scenarios from `latest` to the candidate. If the upgrade check refuses, Install doesn't move `latest`; it offers **Install as a new Box** (a new id, so existing Chats stay on the old Box) or going back to the agent. This covers only the data those scenarios produce. A Chat holding data no scenario reached, such as `{ count: -1 }` when v2 requires `count >= 0`, is still protected by ticket 04's upgrade check, which refuses that Chat's Update. 04b catches what it can earlier; it does not replace that check.
- **No host migrations.** No `migrate(record)` hook, and no stitching versions together through a predecessor and a `convert`. Both need stored data rewritten or records stamped with versions.

## Work

- [x] `from` in `scenarioInput` and `runScenario`; the upgrade check reused, not copied.
- [x] The state diff in `scenarioResult`, shown in the Scenario panel.
- [x] Install's check against `latest`, and **Install as a new Box**.
- [x] `contract.md`: the permanent-log rule and the translate-on-read pattern.
- [x] Tests: a v2 that keeps v1's fields as optional and adds a tagged shape loads and passes `from`; a digesting v2 that widens a choice keeps its passage timeline; a v2 whose record schema drops a v1 field is refused by `from`; a v2 with an adapter passes and its fold reads v1 records; a same-shape change in meaning passes the check and shows in the state diff; Install of an incompatible v2 leaves `latest` unchanged and offers a new Box.
- [x] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.

## Acceptance

- A version that fails the upgrade check on data the session's saved scenarios produce never becomes `latest` silently.
- The agent sees the same refusal a writer would, from its own scenarios, without reading any Chat.
