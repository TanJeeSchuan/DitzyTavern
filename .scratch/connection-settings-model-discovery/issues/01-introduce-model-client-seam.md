# 01 — Introduce the deep Model Client seam

**What to build:** Route ordinary full Message generation through one provider-neutral asynchronous Model Client seam while preserving current behavior. The seam receives the current Prompt Plan as opaque input and makes later production transports replaceable without leaking provider vocabulary into Workflows or Conversations.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] A small Model Client interface accepts an opaque Prompt Plan plus generation input and produces normalized asynchronous events or outcomes.
- [x] Workflows and Conversation modules do not import AI SDK types, provider roles, request bodies, or provider-specific errors.
- [x] The existing Generate workflow uses the Model Client seam without changing current Message authorship, Control, history, or revision behavior.
- [x] A fake Model Client can drive one complete ordinary Generation without network access.
- [x] Generation integration tests assert that the current Prompt Plan is passed unchanged rather than exhaustively asserting its unfinished block composition.
- [x] Existing Prompt Compiler tests remain the authority for current WIP Prompt Plan semantics.
- [x] Existing Generate, Swipe, Conversation, and Prompt Compiler tests remain green.

## Comments

Implemented the provider-neutral asynchronous Model Client seam, deterministic fake client, full-result collector, and Generate/Sibling Variant integration. Existing generation behavior remains unchanged while the Prompt Plan crosses the seam by identity.
