# 06 — Checkpoint and recover Active Generations

**What to build:** Protect visible streamed writing from process failure without turning Generation into a distributed job system. The server should periodically checkpoint provisional output, force terminal persistence, and perform one small recovery sweep after restart.

**Blocked by:** 04 — Make Generation subscriptions resumable; 05 — Move Sibling Generation into the Active Generation lifecycle.

**Status:** complete

- [x] Accumulated Content, Reasoning Content, and latest persisted event position can be checkpointed for any Active Generation target.
- [x] Normalized events continue flowing immediately while database writes occur at a bounded cadence rather than once per delta.
- [x] Tests can trigger checkpointing deterministically without sleeping on production time intervals.
- [x] Every complete, interrupted, length-limited, stopped, or failed terminal outcome forces a final checkpoint or empty-target cleanup.
- [x] Checkpoints do not advance Conversation Revision.
- [x] Creating and terminally resolving or removing a provisional target each advance Conversation Revision as lifecycle transitions.
- [x] Startup marks checkpointed Content or Reasoning Content as interrupted with `server-restart` cause.
- [x] Startup removes abandoned zero-output provisional Tail and Continuation targets while retaining accepted Human-authored Messages.
- [x] Startup removes abandoned zero-output sibling targets and restores their prior selection.
- [x] Recovery never resumes or automatically retries a provider request.
- [x] A graceful shutdown attempts the same terminal transition before closing the database.
- [x] Complete Active Generation records, Prompt Plans, and retained events are removed after the bounded replay period while compact Variant provenance remains.

## Comments

Active Generation rows now carry revision-neutral checkpoint Content, Reasoning
Content, event position, and checkpoint time. The process-local runtime fans out
normalized events before checkpointing at a bounded event/time cadence and
supports deterministic flushes; terminal state remains replayable for a bounded
window before runtime cleanup. Startup and graceful shutdown use a single
recovery sweep that resolves checkpointed output as interrupted with an explicit
cause, removes empty provisional targets, restores failed sibling selections,
and never contacts a provider. Added a migration for the checkpoint columns and
updated the generation lifecycle exports and tests.
