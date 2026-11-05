# Cross-version checks

Status: TODO

Blocked By: 04 (Box versions), and saving each full `run_scenario` input in the session log

Source: the Creator Mode scope discussion of 2026-11-05.

## Goal

An author learns that a new version can't read the old one's data before Install, not when a writer's Update is refused. Compatibility between versions stays the author's responsibility. The host only reports, and never migrates stored data.

## Design decisions already made

- **Records and Moves are a permanent log.** A new version may add shapes, never change what an old shape means. State is never stored, so its shape, `read`, `ui.js` and prompt text change freely. `contract.md` says this, with the translate-on-read pattern: the record schema is `anyOf` the old and new shapes, and the fold converts old records through one adapter function.
- **`run_scenario({ ..., from: <version> })`** runs turns `1..k` on the earlier version, applies ticket 04's upgrade check to the data they left, then runs the remaining turns on the candidate, folding the earlier records. A refusal reads exactly as the writer's Update would.
- **State diff.** The same run also folds the earlier version's records with both versions' folds and reports the difference. It is information, not a failure: a version may change state on purpose. It surfaces the changes no schema can see, such as a field that meant "3 more" now read as "3 total".
- **Install checks against `latest`.** When the Box already has a version, Install replays the session's saved scenarios from `latest` to the candidate. If the upgrade check refuses, Install doesn't move `latest`; it offers **Install as a new Box** (a new id, so existing Chats stay on the old Box) or going back to the agent.
- **No host migrations.** No `migrate(record)` hook, and no stitching versions together through a predecessor and a `convert`. Both need stored data rewritten or records stamped with versions.

## Work

- [ ] `from` in `scenarioInput` and `runScenario`; the upgrade check reused, not copied.
- [ ] The state diff in `scenarioResult`, shown in the Scenario panel.
- [ ] Install's check against `latest`, and **Install as a new Box**.
- [ ] `contract.md`: the permanent-log rule and the translate-on-read pattern.
- [ ] Tests: a v2 whose record schema drops a v1 field is refused by `from`; a v2 with an adapter passes and its fold reads v1 records; a same-shape change in meaning passes the check and shows in the state diff; Install of an incompatible v2 leaves `latest` unchanged and offers a new Box.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.

## Acceptance

- A version that existing Chats couldn't upgrade to never becomes `latest` silently.
- The agent sees the same refusal a writer would, from its own scenarios, without reading any Chat.
