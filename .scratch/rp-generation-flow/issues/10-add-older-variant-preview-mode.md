# 10 — Add older Variant Preview mode

**What to build:** Let users inspect an older alternative without immediately changing authoritative Conversation history. Variant selection outside the Revision window should become a one-target, read-only client preview with downstream skeletons and explicit Confirm Change or Cancel Preview actions.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] The client derives the Revision window as the two latest model-authored Messages and the Human-authored Messages between them.
- [x] Variant selection inside the Revision window retains the existing immediate revisioned server behavior.
- [x] Selecting a Variant outside the Revision window changes only client story state and sends no selection command.
- [x] Preview mode supports exactly one changed Message at a time.
- [x] The previewed Variant renders normally while every causally downstream Message renders as skeleton state.
- [x] Generation, editing, deletion, Control changes, and other server mutations are unavailable during Preview mode.
- [x] A right-side Preview notice explains the state and offers Confirm Change and Cancel Preview.
- [x] Closing the right-side notice leaves a compact persistent Preview indicator near the story.
- [x] Confirm Change sends exactly one ordinary revision-guarded Variant selection command.
- [x] Successful confirmation exits Preview mode and restores every later Message unchanged.
- [x] Cancel Preview restores the server-selected Variant and all downstream Messages without a server mutation.
- [x] Reload discards Preview mode, while client navigation asks before discarding it.
- [x] Preview state is never written to local storage or synchronized to another client.
- [x] Pure client-state and transport tests prove preview, skeleton, gating, confirmation, cancellation, and reset behavior without requiring a browser.
