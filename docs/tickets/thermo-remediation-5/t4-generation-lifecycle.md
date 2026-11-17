# T4: Generation lifecycle

Status: READY

Blocked By: T3

Model: Astra 6 high writes slices a and b; Sol 6.1 high writes c and d and fixes all four.

A Generation on the server should have four verbs: accept, checkpoint, resolve, stop. Today it has three accept commands, a Remove that is Stop with no output, and a crash recovery that re-implements both.

Read ADR 0002, 0013, 0031, 0032, 0034 and 0042. Evidence: reports 17 and 11. The tests each slice must rewrite, with the guarantee each carries, are in report 23's coupling table (rows 1–9).

No slice changes behaviour except where stated.

## Slice a: Stop absorbs Remove and recovery

Report 17, F1 and F2; report 11, finding 4.

- `stopConversationGeneration` takes a `cause`: `user-stop`, `server-restart`, `server-shutdown`, or the provider-failure cause `workflows/generate.ts` passes today when it removes.
- Crash recovery (`workflows/generation-recovery.ts`) calls Stop per row. Delete its own resolve-or-remove branch and `interruptedGenerationData`.
- Delete `removeConversationGeneration` and its input type. Normal completion stops passing reasoning as both a field and a data entry; delete the dedupe clause that existed for it.
- Restore the sibling selection inside the removal, and have Stop All re-read each row by id. Delete the chain walk and the `removedSibling` plumbing.

**Behaviour change:** a removal that races a non-empty checkpoint now commits a stopped Variant where it used to throw. ADR 0002 says interrupted text is never discarded.

## Slice b: one accept command

Report 17, F3, F4 and F5.

- `acceptGeneration(database, capture, target)`, where `target` is the `send | continuation | sibling` union that capture already produces. One transaction: the shared prelude, a `switch` for gate type, eligibility and target creation, then the shared persist and revision advance.
- Eligibility lives in one Conversation-owned function, called by capture in its read transaction and by acceptance. Acceptance-time denials then carry the typed reason capture gives.
- Delete `advanceConversationRevisionGuarded`: every caller has already checked the revision in the same transaction. The macro-variable edit's hand-written prelude becomes `requireConversationRevision`.
- Error precedence is pinned by tests; keep the order of checks.

**Behaviour change:** a Continue refused at acceptance reports the typed reason.

## Slice c: capture carries facts once

Report 11, findings 2, 3, 5 and 6.

- `CapturedGeneration` becomes `{ preparation, plan, macroWrites }`. Delete `AttemptConfiguration`, `toCompilerDefinition` and the connection reshape; `painting/brief.ts` already passes the unshaped objects to the same compiler. Provenance is computed at acceptance.
- Delete `assistantPrefill` from the Model Client input. `model-client/chat-messages.ts` derives the prefix and suffix from the Prompt Plan alone.
- Each arm of `captureTarget` returns the facts later code needs (history bound, gate, Moves source, Box intent, seed default, pending human text), so `snapshotGenerationInputs` stops branching on the kind again.
- The preview fingerprint is built from an explicit list of fields. Delete the three snapshot fields that existed only to be fingerprinted.

## Slice d: the budget result

Report 11, findings 1 and 8.

- Split the budget result into the trim decision (`omittedContext`, made once at compile) and a measurement (`fits`, estimate, breakdown, failure). Delete `PromptBudgetResult.plan`, `retainedContext`, the top-level copies of the breakdown fields, and `budgetEditedPromptPlan`; the edited-plan path measures and keeps the source's `omittedContext`. T1's test for the preview bug must still pass.
- `attempt`, `now`, `random`, `lore` and `loreAllowance` become required compiler inputs. Delete the fallbacks and the unreachable locale `catch`. Tests build their inputs through one attempt factory.

## Rejected

- Making the painting Brief a fourth capture kind.
- Replacing the history-trim binary search with an arithmetic cut, and removing the `tokenEstimator` option: not scheduled.
- Merging `prompt-compiler` and `generation-plan`: ADR 0032 separates them on purpose.

## TODO

- [ ] Slice a (Astra), then fixes (Sol), PR
- [ ] Slice b (Astra), then fixes (Sol), PR
- [ ] Slice c (Sol), PR
- [ ] Slice d (Sol), PR

## Acceptance

`git grep -n -E 'removeConversationGeneration|acceptConversation(Tail|Continuation|Sibling)Generation|advanceConversationRevisionGuarded|AttemptConfiguration|assistantPrefill|budgetEditedPromptPlan|retainedContext' -- src` is empty. The recovery, Stop, acceptance and capture tests pass, and e2e passes in CI.

## Outcome
