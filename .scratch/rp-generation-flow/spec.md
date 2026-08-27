# RP Generation flow

Status: ready-for-agent

## Problem Statement

DitzyTavern does not yet have one authoritative end-to-end Generation flow from human writing through Prompt Plan compilation, provider communication, live output, and persisted Messages. The composer currently accepts a draft without persisting or compiling that draft. Active output exists primarily in the initiating client until the provider request terminates, so another client cannot observe the same authoritative response position and a browser disconnect can cancel work that should belong to the server.

Prompt compilation currently includes all selected history without enforcing the configured context limit. Continue behavior is not represented explicitly, and existing Variant selection can rewrite an older Selected narrative path immediately without giving the user a safe preview of its downstream effect.

Users need one RP-like writing flow for both cooperative writing and in-character roleplay. They need their input to remain visible as causality, model writing to stream and survive independently of one browser connection, prompt size to be reduced predictably, continuation to work across different model APIs, and older alternatives to be inspectable without accidental persistence.

## Solution

Provide one server-owned Generation system for normal Send, Continue, and Sibling Generation. Co-writing and in-character roleplay use the same Conversation, Control, Message, and Variant concepts.

A non-empty Send first becomes a Human-authored Message and starts a Tail Generation. Continue starts a Tail Generation without a new human Message and always creates a new, ordinary model-authored Message. Sibling Generation creates a new Variant at an existing Message position. The server compiles a provider-neutral Prompt Plan from the controlled pair and Selected narrative path, reduces history to the configured context budget using a replaceable `tokenx` estimator, creates a Provisional Variant, communicates with the provider, normalizes provider events, checkpoints partial output, and resolves the Generation to durable Conversation state.

Clients subscribe to server-owned Generation events. Disconnecting a client does not cancel work. Completed and partial outputs retain safe provenance, while empty failed targets are removed. Older Variant selection enters a single-target client Preview mode before the existing server selection command is sent. The preview makes downstream uncertainty visible with skeleton state and requires explicit confirmation.

## User Stories

1. As a cooperative writer, I want my guidance to become a visible Human-authored Message, so that the resulting model prose has an inspectable cause.
2. As an in-character roleplayer, I want my dialogue or action to use the same Message flow as writing guidance, so that I do not have to choose a separate RP mode.
3. As a user, I want the Participant holding human Control to author my submitted Message, so that authorship reflects who produced it.
4. As a user, I want the Participant holding model Control at Generation start to author the generated Message, so that later Control changes do not rewrite attribution.
5. As a user, I want Message authorship to identify the producer rather than fictional speakers inside the prose, so that narration containing several characters remains one coherent Message.
6. As a user, I want Send to validate the Conversation and prompt before accepting my input, so that invalid or oversized requests leave my draft available for correction.
7. As a user, I want an accepted Human-authored Message to remain when the provider later fails, so that my writing is never erased by a model outage.
8. As a user, I want a retry after a zero-output failure to start another Generation without duplicating my Human-authored Message, so that history remains clean.
9. As a user, I want a dedicated Continue action, so that I can request more model writing without submitting an empty Message.
10. As a user, I want Continue to be available only after a terminal model-authored Message, so that it cannot be confused with an ordinary response to human input.
11. As a user, I want Continue hidden or unavailable while another Generation is active, so that two response positions cannot race.
12. As a user, I want a Continuation Generation to create a new ordinary model-authored Message, so that it never rewrites completed content.
13. As a user, I want continued Messages to render like normal Messages, so that editing, Swipes, deletion, and provenance remain understandable.
14. As a user, I want Continue to use the current model Control assignment, so that a Control change is honored instead of silently restoring an earlier Participant.
15. As a user, I want the interface to state which Participant will continue, so that an identity change is visible before spending tokens.
16. As a power user, I want an editable Continuation instruction, so that I can tune instruction-based continuation for my model.
17. As a power user, I want to choose instruction or Assistant prefill as the Continuation strategy, so that I can use the method that works best with my endpoint.
18. As a power user, I want Assistant prefill to support no suffix, a space, a newline, or two newlines, so that I can shape the continuation boundary expected by my model.
19. As a user, I want request-only continuation instructions and suffixes to leave stored Messages unchanged, so that transport shaping never edits history.
20. As a user, I want a complete, length-limited, or interrupted Variant with visible content to be continuable, so that I can extend useful partial writing.
21. As a user, I want a reasoning-only Variant to use instruction continuation but not Assistant prefill, so that private reasoning is not silently returned as ordinary model history.
22. As a user, I want Tail Generation to use the selected Variant of every preceding Message, so that the model sees the current narrative path.
23. As a user, I want Sibling Generation to use selected history strictly before its target, so that an alternative does not see itself, its siblings, or later writing.
24. As a user, I want only the controlled Participants' Definitions in the first prompt-composition version, so that unseated Cast members do not introduce hidden precedence or prompt growth.
25. As a user, I want older whole Messages removed first when context is tight, so that recent causality remains available.
26. As a user, I want the latest Human-authored Message protected from automatic context reduction, so that the model never loses the input it is answering.
27. As a user, I want Generation rejected when fixed prompt content and the protected human Message cannot fit, so that the application does not silently split or corrupt input.
28. As a user, I want omitted history disclosed through prompt inspection, so that I can understand what the model did not receive.
29. As a power user, I want a visible Token estimate, response budget, and Safety allowance, so that I can understand the preflight calculation.
30. As a power user, I want the Safety allowance configurable in Conversation Generation Settings, so that I can adjust the default 500-token reserve.
31. As a user, I want the Token estimate described as approximate, so that it is not mistaken for an exact provider count or acceptance guarantee.
32. As a user, I want the server to own provider credentials and protocol handling, so that browsers never contact model providers directly.
33. As a user with several clients, I want every client to observe the same Active Generation and Provisional Variant, so that no browser becomes a temporary source of truth.
34. As a user, I want normalized Content, Reasoning Content, usage, finish, and failure events, so that provider-specific stream formats do not leak into the interface.
35. As a user, I want streamed output to appear immediately, so that long Generations feel responsive.
36. As a user, I want streamed output checkpointed periodically, so that a server crash loses at most the uncheckpointed tail.
37. As a user, I want a final checkpoint at every terminal outcome, so that persisted writing matches the terminal event.
38. As a user, I want reloading, navigating, or disconnecting my client to leave Generation running, so that browser state does not cancel server work.
39. As a user, I want explicit Stop and Stop All controls, so that cancellation remains intentional and targeted.
40. As a user, I want visible partial Content or Reasoning Content retained after cancellation or transport failure, so that useful writing is not discarded.
41. As a user, I want a zero-output provisional target removed, so that failed attempts do not leave empty model Messages or Variants.
42. As a user, I want the prior Variant selection restored when an empty Sibling Generation fails, so that a failed alternative does not change displayed history.
43. As a user, I want provider requests never retried automatically, so that ambiguous failures cannot cause hidden duplicate charges or writing.
44. As a user, I want a length-limited result marked distinctly without automatic continuation, so that I decide whether to Continue.
45. As a user, I want safe Generation settings, usage, finish reason, status, and interruption cause retained with the resulting Variant, so that I can inspect how it was produced.
46. As a user, I want credentials, configured headers, and connection URLs excluded from Variant provenance and client errors, so that secrets never enter Conversation history.
47. As a user, I want the captured Prompt Plan inspectable while Generation is active, so that I can examine the exact provider-neutral input in flight.
48. As a user, I want the captured Prompt Plan discarded after the bounded replay period, so that selected history is not copied permanently into every Variant.
49. As a user, I want a server restart to retain checkpointed partial output as interrupted writing, so that recovery is predictable.
50. As a user, I want a server restart to remove an empty provisional target without retrying it, so that recovery remains small and safe.
51. As a user, I want an accepted Human-authored Message preserved through server restart recovery, so that model lifecycle cleanup cannot erase my work.
52. As a user, I want recent Variant selection to persist normally, so that revising the immediate setup and model response stays quick.
53. As a user, I want selecting a Variant outside the Revision window to enter Preview mode, so that an exploratory historical Swipe is not immediately authoritative.
54. As a user, I want Preview mode to show one changed Message at a time, so that the pending change remains understandable and confirmable with one command.
55. As a user, I want downstream writing replaced by skeleton state during an older Variant preview, so that I do not mistake causally uncertain Messages for the previewed path.
56. As a user, I want a persistent Preview mode indicator even when the right panel closes, so that I cannot forget that the visible history is local-only.
57. As a user, I want server mutations blocked during Preview mode, so that an operation cannot run against a different server path than the one I see.
58. As a user, I want Confirm Change to persist the previewed Variant through the ordinary revisioned command, so that confirmation uses established conflict protection.
59. As a user, I want later Messages retained unchanged after Confirm Change, so that historical selection never deletes or rewrites my work implicitly.
60. As a user, I want Cancel Preview to restore the server-selected path, so that exploration is reversible.
61. As a user, I want reload to discard client-only Preview mode, so that an obsolete local preview cannot appear authoritative later.
62. As a user, I want navigation to another Chat to warn before discarding Preview mode, so that I do not lose an intentional pending selection accidentally.

## Implementation Decisions

- Conversation remains the primary aggregate. Message represents one authored position, Variant represents one alternative at that position, and exactly one Variant is selected per Message.
- Co-writing guidance and in-character RP input are usage styles of ordinary Human-authored Messages. They do not create separate Message types or application modes.
- Message authorship records the Participant that produced the Message. It does not classify fictional speakers within content.
- Send-and-Generate is one accepted operation from the user's perspective. Preflight occurs before acceptance. Acceptance atomically persists the Human-authored Message, Active Generation, and provisional model target under a revision check.
- Tail Generation creates a new model-authored Message with one Provisional Variant. Sibling Generation creates a Provisional Variant on an existing Message. Continue is a Tail Generation with continuation intent and no new Human-authored Message.
- Continue creates an entirely new normal Message and never appends to, rewrites, or visually merges with the previous Variant.
- Continue is available only when the latest selected Message is terminal and model-authored, the Conversation is playable, and no conflicting Active Generation exists.
- Current model Control supplies continuation authorship and the current controlled pair supplies the Prompt Plan. A changed model Participant is shown explicitly before Continue starts.
- Prompt Plan gains provider-neutral Generation intent. The initial intents are respond and continue.
- Conversation Generation Settings gain a configurable Safety allowance with a default of 500 tokens, Continuation strategy, required editable Continuation instruction, and Prefill suffix.
- Continuation strategy has two explicit values: instruction and Assistant prefill. Instruction is the default. There is no automatic capability detection in version one.
- Instruction strategy adds an ephemeral Continuation instruction to the Prompt Plan and does not add a synthetic Message to Conversation history.
- Assistant prefill ignores the Continuation instruction and shapes the preceding model content as a provider request prefix. Unsupported explicit prefill fails clearly instead of silently changing strategy.
- Prefill suffix has four values: none, space, newline, and double newline. It affects only request construction and never stored content.
- A reasoning-only Variant may use instruction continuation. Assistant prefill is unavailable because version one excludes Reasoning Content from subsequent prompt history.
- Prompt compilation remains pure and provider-neutral. It consumes the two controlled Participants' current Definitions and normalized selected history. Automatic Definition composition for other Cast members is deferred.
- Tail and Continue history contains the selected Variant of every preceding Message. Sibling history contains selected Variants strictly before the target Message and excludes all target Variants and later Messages.
- Prompt blocks retain the established order and macro rules. A new Human-authored Message participates in the candidate Prompt Plan used for preflight before it is persisted.
- Prompt budgeting removes the oldest whole history Message and recompiles until the request fits. It never splits a Message, automatically summarizes history, or removes the latest Human-authored Message.
- If fixed prompt blocks plus protected recent input cannot fit, Generation fails before acceptance with an inspectable size breakdown.
- `tokenx` is pinned and hidden behind a project-owned synchronous Token Estimator interface. It is an approximation component, not a provider-fit oracle.
- The estimator counts one deterministic Estimation transcript built from the final ordered Prompt Plan with stable block and role separators. It does not sum independently rounded block estimates.
- Version one uses no separate adapter framing allowance. The configurable 500-token Safety allowance covers general estimation and framing uncertainty for now.
- Preflight compares Token estimate, response budget, and Safety allowance against the configured context limit. It rebuilds and re-estimates the complete transcript after each history omission.
- Prompt inspection exposes Generation intent, the reduced Prompt Plan, omitted history, Token estimate, response budget, and Safety allowance. It never labels an estimate as exact.
- The server exclusively owns Active Generations and provider communication. Clients never receive credentials or provider-native protocols.
- Active Generation storage identifies its Conversation, target Message and Variant, current status, captured Control and authorship, safe connection identity, effective Generation Settings, active Prompt Plan, accumulated Content and Reasoning Content, ordered event position, and the information needed to restore a failed sibling's prior selection.
- The provider request begins only after the provisional target and Active Generation exist authoritatively.
- Provider adapters receive the provider-neutral Prompt Plan, Generation intent, normalized history authorship, effective settings, and safe connection snapshot. They return normalized application events.
- Normalized events include Content delta, Reasoning Content delta, usage, finish, and typed failure information. Provider request and response secrets never enter normalized events.
- Clients subscribe to server-owned Generation events identified by Generation and ordered event IDs. Starting work and observing work are logically separate, even if the transport exposes a convenient combined operation.
- Client disconnect, reload, and navigation only end that client's subscription. They do not pass cancellation to the provider request.
- Explicit Stop targets one selected Generation. Stop All targets every Active Generation at the response position. Provider inactivity, provider termination, and server shutdown may also terminate work.
- Normalized events are emitted immediately. The server periodically checkpoints accumulated Content, Reasoning Content, and persisted event position, then forces a final checkpoint at termination.
- Checkpoints do not advance Conversation Revision. Generation events use their own ordered sequence. Creating and terminally resolving or removing a provisional target are Conversation lifecycle transitions and do advance Revision.
- Content or Reasoning Content makes a Provisional Variant durable. Terminal zero-output failure removes the provisional model target while retaining an accepted Human-authored Message.
- Complete, length-limited, and interrupted outcomes persist distinctly. No provider failure automatically retries or continues.
- Variant provenance retains effective Generation Settings, safe Profile identity and revision, resolved backend and adapter, model ID, normalized usage, finish reason, terminal status, and interruption cause. It excludes secrets, configured headers, and URLs.
- The complete Active Generation record and captured Prompt Plan remain only through the bounded SSE replay period. Compact Variant provenance remains after cleanup.
- Startup performs one small recovery sweep. Checkpointed output becomes interrupted with `server-restart` cause. Empty provisional targets are removed. Failed siblings restore their prior selection. No provider request is resumed or retried.
- Revision window means the two latest model-authored Messages and the Human-authored Messages between them. Existing recent selection behavior remains immediate.
- Selecting a Variant outside the Revision window creates one client-local Preview mode target and does not send the selection command.
- Preview mode renders the previewed Variant, replaces causally downstream Messages with skeleton state, blocks server mutations, and provides Confirm Change and Cancel Preview.
- The right-side Preview notice may close, but a compact persistent story indicator remains until Preview mode ends.
- Confirm Change sends the ordinary revision-guarded Variant selection command. Later Messages remain unchanged because the user explicitly accepts that historical change.
- Cancel Preview and reload discard Preview mode. Navigating to another Chat requires confirmation before discard. Preview state is never restored from local storage.
- Existing active-response-position rules remain. Parallel Sibling Generations are limited to the same eligible Message and each captures its own Prompt Plan and Generation Settings. New Conversation turns remain blocked until the active response position closes.

## Testing Decisions

- Good tests assert behavior visible at a module or transport boundary: accepted or rejected commands, Prompt Plans and provider requests, ordered normalized events, Conversation snapshots, Variant provenance, and client story state. Tests should not assert table layout, timer implementation, private helper calls, or exact checkpoint cadence.
- The primary seam is the Generation HTTP contract using an in-memory database and a fake provider transport. One test can start Generation, inspect the captured provider request, observe normalized SSE, reload authoritative Conversation state, and verify the terminal Message or Variant and safe provenance.
- Extend the existing Generation transport contract tests rather than creating provider-network integration tests. Existing prior art already captures request bodies, returns controlled provider streams, reads final Conversation state, and checks that secrets do not leak.
- Exercise Send-and-Generate through the primary HTTP seam. Verify candidate preflight, atomic Human-authored Message and Provisional Variant creation, model authorship, selected history, terminal cleanup, and preservation of human input after provider failure.
- Exercise Continue through the primary HTTP seam. Verify eligibility, current model Control authorship, separate Message creation, instruction intent, Assistant prefill shaping, every Prefill suffix, and the absence of synthetic or mutated stored Messages.
- Exercise Sibling Generation through the primary HTTP seam. Verify history stops before the target, provisional selection behavior, independent settings provenance, parallel-sibling rules, and prior-selection restoration after zero-output failure.
- Test the Token Estimator through the Generation workflow or prompt-inspection boundary, not by copying `tokenx`'s own unit tests. Verify one Estimation transcript, the default and configured Safety allowance, oldest-whole-Message omission, latest-human protection, recomputation after each omission, and inspectable rejection when protected content cannot fit.
- Use the existing pure Prompt Compiler tests for named-block order, owner-relative macros, warnings, Generation intent, reduced history, and the provider-neutral contract.
- Use focused Model Client adapter tests only for differences that the primary route seam cannot express economically. Verify instruction placement, Assistant prefill placement, Prefill suffix handling, unsupported-prefill failure, role mapping, and that provider-native values do not leak back into the Prompt Plan.
- Test Active Generation lifecycle through a server-owned Generation service with a controllable fake Model Client. Hold streams open to observe provisional targets, concurrent subscribers, explicit Stop, Stop All, checkpoint state, and terminal transitions without sleeping on wall-clock time.
- Test disconnect behavior by cancelling one client subscription while the controlled provider continues, then attach another subscriber or reload state and verify Generation was not cancelled.
- Test resumable delivery with ordered event IDs. Verify replay after a known event and authoritative snapshot fallback when the bounded replay buffer no longer contains the requested event.
- Test checkpoint behavior by emitting several controlled deltas, triggering the checkpoint seam deterministically, and reading the Provisional Variant. Do not assert a production millisecond or byte threshold.
- Test restart recovery against a temporary database. Seed active rows through the public Generation lifecycle, checkpoint output, recreate the server-owned Generation service, and verify interrupted retention, empty-target removal, sibling-selection restoration, accepted-human preservation, and no provider retry.
- Keep workflow-level tests with the injected fake Model Client as prior art for captured start-time authorship, Prompt Plan freezing, safe settings provenance, partial output, reasoning-only output, cancellation, length limits, and concurrent Conversation edits.
- Keep Conversation module tests as prior art for revisioned commands, Message and Variant invariants, selected history, commit behavior, and typed failures.
- The client Preview mode seam is the pure story-state reducer. Extend it rather than relying primarily on browser tests. Verify Revision window derivation, one preview target, downstream skeleton state, mutation gating, persistent indicator state, confirm, cancel, reload reset, and navigation-discard confirmation state.
- Test Confirm Change at the client transport boundary to verify that no selection command is sent during preview and exactly one revisioned command is sent on confirmation.
- Add focused component tests only for accessible Preview notice, compact persistent indicator, skeleton presentation, Continue availability and identity copy, Generation status, Stop controls, and contextual errors. Do not duplicate reducer rules in component fixtures.
- Preserve current client stream-decoder tests as prior art for split SSE frames, malformed event rejection, normalized deltas, and terminal results. Extend them with Generation IDs, ordered event IDs, replay, and subscription cancellation that does not cancel server work.
- Include negative contract cases: no active Connection Profile, unplayable Conversation, stale Revision, missing Conversation, oversized protected prompt, unsupported Assistant prefill, invalid Continuation settings, Continue after human history, and conflicting Active Generation.
- Test provenance by positive allow-list. Assert the required safe identity, settings, usage, status, and interruption fields, then assert credentials, header values, request URLs, raw provider bodies, and complete Prompt Plans are absent.

## Out of Scope

- Automatic prompt composition for more than the controlled pair, including precedence rules for larger Cast Definitions.
- Group-chat turn orchestration, active or inactive Cast membership, and automatic fictional-speaker detection inside generated prose.
- Exact provider tokenization or a guarantee that a provider accepts the estimated request.
- A calibration corpus, model-specific tokenizer registry, automatic language detection, or provider-specific Token Estimator selection.
- Automatic history summarization, partial-Message truncation, semantic retrieval, or long-term memory injection.
- Automatic retries, automatic continuation after a length limit, provider fallback, or queued Generation attempts.
- Permanent Prompt Plan auditing or permanent storage of the complete Active Generation record and SSE history.
- Resuming an interrupted provider request after server restart. Recovery only resolves abandoned local state.
- Automatic capability discovery for Assistant prefill. Users select the strategy explicitly.
- OpenAI Responses and Anthropic Messages shaping beyond the separately designed and implemented API Format work.
- Tool calls, audio, images, non-text modalities, and returning Reasoning Content to later ordinary prompts.
- Atomic confirmation of several historical Variant previews. Preview mode has one target.
- Automatic deletion, rewriting, branching, or regeneration of later Messages after an older Variant is confirmed.
- Persisting Preview mode in local storage or synchronizing a preview across clients.
- Implementing the deferred Branch feature or changing the server's general revisioned Variant selection command.

## Further Notes

- The confirmed domain vocabulary is maintained in the project glossary. Implementation and interface copy should use Generation, Generation attempt, Generated Variant, Tail Generation, Sibling Generation, Continuation Generation, Selected narrative path, Active Generation, Provisional Variant, Generation checkpoint, Token estimate, Safety allowance, Estimation transcript, Revision window, Preview mode, and Confirm Change consistently.
- The design is governed by the existing ADRs for server authority, revisioned HTTP and resumable SSE, Messages and Variants, parallel sibling Generation, pure Prompt Plan compilation, deep Model Client isolation, Conversation Generation Settings, safe connection provenance, and active prompt inspection, plus the ADRs created during this design session for Preview mode, Continuation Messages, and server-owned Active Generations.
- `tokenx` version 2.1.0 is suitable only as a fast deterministic approximation. It is calibrated to `o200k_base`, knows no model IDs or provider framing, and documents large underestimates for high-entropy text and some scripts. The project-owned estimator boundary must make later replacement straightforward.
- The default 500-token Safety allowance is an explicit temporary product setting, not a measured uncertainty interval.
- Server restart recovery should remain intentionally small. It is a cleanup sweep, not a durable distributed job system.
- The selected test seams are the highest existing seams that cover the behavior without forcing browser or provider-network tests. The Generation HTTP contract is primary; the pure story-state reducer is required because Preview mode is intentionally client-only; adapter tests remain narrow.
