# Creator Mode: revisions, live preview, saved sessions

Status: DEFERRED

Blocked By: 03

Source: the ticket 03 plan review (2026-11-04), which split these out of the first slice.

## Goal

Pick these up only when using ticket 03 shows they're needed. Each one needs more than the first slice's design suggested:

- **Revising an installed Box.** The startup schema check isn't a read-only preview: it removes invalid automatic records and traces and updates schema fingerprints (`src/server/box/schema-check.ts`, `src/server/conversation/box-values.ts`). A revision needs a preflight that changes nothing. It also needs an activation step coordinated with new Generations and digests. Existing UI caches and Workers need invalidating too: the UI source is cached forever under `[box, "ui"]` in `BoxFrame.tsx`, and frame tokens identify insertion instances, not code versions. Without all three, data changes before the revision is accepted, and old and new versions run side by side.
- **A live preview of an uninstalled candidate's UI.** The current frame is bound to an installed Box, a Chat and an insertion instance, and its interactions are real (`commit-box`, uploads). A preview needs a frame bound to the candidate, using the same Worker, sanitizer and CSP, with scenario capabilities in place of real ones.
- **Authoring sessions that survive a restart.** The spike measured creating a libfx checkpoint, but not restoring one, how it grows, or cancelling it during host tools. First prove checkpoint, then close, then restore, then the next tool call, against a localhost fake, with candidate files kept and tool bindings recreated.
