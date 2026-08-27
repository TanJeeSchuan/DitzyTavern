# 01 — Introduce the Generation coordinator seam

**What to build:** Introduce a server-owned Generation coordinator behind the current Generate behavior. Users should see no regression while prompt capture, provider invocation, normalized events, and terminal Conversation commits move behind one injectable orchestration seam that later tickets can extend safely.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Current Tail Generation still produces one model-authored Message with one selected Variant through the existing public contract.
- [x] The coordinator captures the Prompt Plan, controlled pair, Author Stamp, effective Generation Settings, and safe connection identity before contacting the Model Client.
- [x] Provider invocation occurs only through the injected Model Client seam.
- [x] Provider-native request and response shapes remain private to the Model Client.
- [x] Normalized Content, Reasoning Content, usage, finish, and typed failure events pass through the coordinator.
- [x] Complete, interrupted, length-limited, cancellation, reasoning-only, and zero-output behavior remains externally unchanged.
- [x] Mid-flight Participant, Definition, Profile, or Generation Settings edits affect only later Generations.
- [x] Workflow and HTTP contract tests use a controllable fake Model Client or fake provider without real network access.
- [x] Existing Generation tests remain green after callers migrate to the coordinator.

## Comments

Implemented the server-owned Tail Generation coordinator seam. Existing workflow callers retain `generateReply`, while HTTP generation routes now invoke the coordinator directly. The seam freezes the provider-neutral Prompt Plan, Control pair, Author Stamp, effective settings, and safe connection identity before invoking the injected Model Client, and forwards normalized events without exposing provider protocol details.
