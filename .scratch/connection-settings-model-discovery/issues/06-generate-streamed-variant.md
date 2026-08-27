# 06 — Generate a complete streamed Variant through the active Profile

**What to build:** Let a Conversation select a free-text model and produce one complete streamed text Variant through the globally active Connection Profile, while snapshotting safe connection and generation provenance at start.

**Blocked by:** 04 — Manage the global Connection Profile lifecycle; 05 — Test a DeepSeek draft through the AI SDK Backend.

**Status:** complete

- [x] Conversation Generation Settings own model ID, sampling values, context limit, response budget, and Chat Completions Request Overrides independently of Connection Profiles.
- [x] A free-text model ID can be saved and used before model discovery exists.
- [x] Starting Generation resolves and snapshots the active Profile identity, Connection Settings revision, Backend, Adapter, and effective Conversation Generation Settings before outbound work.
- [x] The current Prompt Plan crosses the Model Client seam unchanged and remains opaque to these integration tests.
- [x] The active DeepSeek Profile produces a streamed visible-text response through the production AI SDK Backend.
- [x] One Generation forces one choice and persists at most one new Variant with correct Message authorship and Control semantics.
- [x] Safe provenance is stored per Variant so sibling Variants can record different settings or connection revisions.
- [x] Credentials, custom headers, master-key material, and connection URLs never enter Variant provenance, snapshots, client events, or logs.
- [x] Editing or activating Profiles during a running Generation does not alter its snapshot; the next Generation uses the newly authoritative state.
- [x] Switching the active global Profile never rewrites Conversation Generation Settings.
- [x] Full workflow and contract tests use fake normalized streams or controlled fake HTTP and never contact a paid provider.
