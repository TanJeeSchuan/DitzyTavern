# Creator Mode: revisions, live preview, saved sessions

Status: DEFERRED

Blocked By: 03

Source: the ticket 03 plan review (2026-11-04), which split these out of the first slice.

## Goal

Pick these up only when using ticket 03 shows they're needed. Each one needs more than the first slice's design suggested:

- **Revising an installed Box.** Superseded by [ticket 04](04-box-versions.md): versions pinned per Chat replace the global swap described here.
  The concerns ticket 04 answers: The startup schema check isn't a read-only preview: it removes invalid automatic records and traces and updates schema fingerprints (`src/server/box/schema-check.ts`, `src/server/conversation/box-values.ts`). A revision needs a preflight that changes nothing. It also needs an activation step coordinated with new Generations and digests. Existing UI caches and Workers need invalidating too: the UI source is cached forever under `[box, "ui"]` in `BoxFrame.tsx`, and frame tokens identify insertion instances, not code versions. Without all three, data changes before the revision is accepted, and old and new versions run side by side. [Ticket 04](04-box-versions.md) answers them with per-Chat version pins: a read-only upgrade check, work that carries its version, and frames keyed by version, so versions do run side by side, each Chat on the one it pins.
- **A live preview of an uninstalled candidate's UI.** The current frame is bound to an installed Box, a Chat and an insertion instance, and its interactions are real (`commit-box`, uploads). A preview needs a frame bound to the candidate, using the same Worker, sanitizer and CSP, with scenario capabilities in place of real ones.
- **Authoring sessions that survive a restart.** The spike measured creating a libfx checkpoint, but not restoring one, how it grows, or cancelling it during host tools. First prove checkpoint, then close, then restore, then the next tool call, against a localhost fake, with candidate files kept and tool bindings recreated.
  - [x] Done 2026-11-05. `saved-session.test.ts` proves checkpoint, release, a new authoring server on the same folder, restore, the next turn carrying the earlier one, and the next tool call writing the kept candidate, against a localhost fake. Sessions are folders under `data/authoring/<session>/`: `meta.json`, `checkpoint.bin` (written after each turn), `log.ndjson` (the writer's messages and every streamed event, replayed on open) and the candidate. Closing the panel releases a session and `/discard` deletes it; startup removes only folders without `meta.json`. A session links to the Box it installed by id alone, and the Box manager offers **Open its session** on that Box. Checkpoint growth and a libfx upgrade breaking old checkpoints remain unmeasured: opening one that fails is refused with a prompt to discard it.
