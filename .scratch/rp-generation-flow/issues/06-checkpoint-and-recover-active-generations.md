# 06 — Checkpoint and recover Active Generations

**What to build:** Protect visible streamed writing from process failure without turning Generation into a distributed job system. The server should periodically checkpoint provisional output, force terminal persistence, and perform one small recovery sweep after restart.

**Blocked by:** 04 — Make Generation subscriptions resumable; 05 — Move Sibling Generation into the Active Generation lifecycle.

**Status:** ready-for-agent

- [ ] Accumulated Content, Reasoning Content, and latest persisted event position can be checkpointed for any Active Generation target.
- [ ] Normalized events continue flowing immediately while database writes occur at a bounded cadence rather than once per delta.
- [ ] Tests can trigger checkpointing deterministically without sleeping on production time intervals.
- [ ] Every complete, interrupted, length-limited, stopped, or failed terminal outcome forces a final checkpoint or empty-target cleanup.
- [ ] Checkpoints do not advance Conversation Revision.
- [ ] Creating and terminally resolving or removing a provisional target each advance Conversation Revision as lifecycle transitions.
- [ ] Startup marks checkpointed Content or Reasoning Content as interrupted with `server-restart` cause.
- [ ] Startup removes abandoned zero-output provisional Tail and Continuation targets while retaining accepted Human-authored Messages.
- [ ] Startup removes abandoned zero-output sibling targets and restores their prior selection.
- [ ] Recovery never resumes or automatically retries a provider request.
- [ ] A graceful shutdown attempts the same terminal transition before closing the database.
- [ ] Complete Active Generation records, Prompt Plans, and retained events are removed after the bounded replay period while compact Variant provenance remains.

