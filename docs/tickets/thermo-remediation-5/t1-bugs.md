# T1: Bugs

Status: IN PROGRESS

Blocked By: None

Model: Sol 6.1 high. Run a thermo-nuclear review (`~/.agents/skills/thermo-nuclear-code-quality-review/SKILL.md`) on items 1, 7 and 10 before opening the PR; they sit on the Box boundary.

Evidence: `~/Projects/DitzyTavern-eval/answer-key/bugs.md`. Each item was confirmed by reading the code; none was reproduced by running it. Reproduce each with a failing test first. If a test passes on the base, the premise is wrong: drop the item and say so in the Outcome.

One PR, one commit per item.

## Items

1. **Participant removal ignores Box references.** `conversation/tombstone.ts` hard-deletes a Participant when no Message references it; `conversation/cleanup.ts` also checks Box values before collecting. Make `tombstone` always tombstone, then call `collectReleasedTombstones`, which already applies both rules. `snapshot.ts` keeps the Message-only predicate: it answers a wording question for the removal confirmation. Detail: report 17, F7. Test: `conversation/tombstones.test.ts`, beside the existing Box-reference test; remove a Participant named only by a `box:memory` label row, with no Message that refers to it.

2. **A Generation started from a preview loses its omitted context.** `acceptedEditedPlan` (`workflows/generation-preview.ts`) replaces the captured budget with `budgetEditedPromptPlan`'s, whose `omittedContext` is empty. Carry the captured plan's `omittedContext` through acceptance. The budget type itself is reshaped in T4d; here, only stop the loss. Test: `workflows/generate.test.ts`, extending the history-trimming test; accept a preview and read the stored inspection.

3. **Preview consume can throw after acceptance commits.** In `workflows/generate.ts`, acceptance commits and then `consumeGenerationPreview` can throw when a newer preview replaced the record. Claim the preview before acceptance, or make consuming a delete that cannot throw. Detail: report 11, finding 10.

4. **Decision Model requests follow redirects with credentials.** Set `redirect: "error"` inside `fetchWithTimeout` (`model-client/model-fetch.ts`) so every caller gets it: the Decision Model, embeddings and model discovery. Test the request `init` each of the three sends.

5. **The preview fingerprint ignores Box image grants.** `boxImages` is a `Map`, which `JSON.stringify` turns into `{}` (`workflows/generation-preparation-fingerprint.ts`). Serialise the grants so a changed grant makes a preview stale. Leave the rest of the fingerprint alone; T4c narrows it.

6. **An imported fork drops the Portrait.** `sillytavern/staged.ts` copies four Definition fields from the Character; `character-library/fork.ts` copies those and `portrait`. Give the Character Library one function that projects a snapshot to its Definition and use it in both places.

7. **`set-box-setup` does not survive a throwing `setupError`.** `conversation/commands/set-box-setup.ts` calls it unguarded; `conversation/box-upgrade.ts` wraps the same call. Catch it and fail the command with `InvalidConversationCommandError` carrying the thrown message. Test with a plugin Box whose `setupError` throws.

8. **Memory's touch radio has no border.** `src/boxes/memory/client.css` uses `var(--input)`, which is declared nowhere. Use `var(--border-strong)`. No test.

9. **`db:teardown` and a Chat forked from a seeded Character.** `participant.source_character_id` has no `onDelete`, and teardown deletes seeded Characters. Add the case to `database/teardown.test.ts`: a user Chat with a Participant forked from a seeded Character. If it fails, make teardown release seeded Characters the way the Character Library deletes one (`character-library/tombstone.ts`), so a referenced Character is tombstoned.

10. **A sandboxed Box can declare a Chat value it can never write.** `shared/contract/box-sandboxed.ts` accepts `values.chat`, and `commit-box` takes only Library, Character and Participant owners. Make the loader refuse a sandboxed descriptor that declares `values.chat`, with a message saying why. Update `docs/box-system/sandboxed.md` and `src/server/authoring/contract.md` where they describe declared values.

Bug 8 in `bugs.md` (paint preset commands with no revision) is fixed in T5c.

## Rejected

- `onDelete: "set null"` on `source_character_id`: it would silently drop provenance that ADR 0017 keeps.
- Adding a Chat owner to `commit-box`: no sandboxed Box needs it yet.

## TODO

- [ ] Items 1–7, 9, 10: failing test, then fix, one commit each
- [ ] Item 8
- [ ] Thermo-nuclear review of items 1, 7, 10
- [ ] Typecheck, the touched test files, then CI

## Acceptance

Each new test fails on the base commit and passes on the branch. `grep -n 'var(--input)' src/boxes/memory/client.css` is empty.

## Outcome
