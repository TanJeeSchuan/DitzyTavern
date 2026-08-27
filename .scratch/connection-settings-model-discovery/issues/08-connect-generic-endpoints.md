# 08 — Connect unusual endpoints with the Generic Adapter and secret headers

**What to build:** Let an advanced user connect a generic OpenAI-compatible or unusual exact endpoint using visible shared Profile configuration, redacted custom headers, and Conversation-owned request extensions in both Test Connection and ordinary Generation.

**Blocked by:** 06 — Generate a complete streamed Variant through the active Profile.

**Status:** complete

- [x] A Generic OpenAI Compatible Preset creates an editable Profile with blank request and Models URLs, Automatic Backend, OpenAI Compatible Adapter, Chat Completions Format, and no pinned models.
- [x] The OpenAI Compatible Adapter is bundled and selectable under Advanced settings without exposing an arbitrary package name or provider-options object.
- [x] The Adapter honors both conventional base URLs and exact nonstandard destinations such as `/generate`, including when its underlying SDK normally appends a path.
- [x] Custom-header keys and configured states return to the client while stored values never do.
- [x] The header editor uses the approved JSON editor against a safe redacted projection and explicit keep, replace, and remove drafts.
- [x] Header names are valid HTTP tokens, unique case-insensitively, and display casing is preserved.
- [x] Host, Content-Length, Transfer-Encoding, and other transport-owned headers are rejected.
- [x] An explicit custom Authorization header may replace standard dedicated-credential authentication; Profiles using only custom authentication may omit the dedicated credential.
- [x] Profile Apply atomically commits ordinary draft fields and custom-header secret operations under the expected global revision.
- [x] Chat Completions Request Overrides are Conversation-owned and Format-namespaced, merge late, allow unknown provider fields, and cannot replace structural messages, model, stream, n, or Format-owned output limits.
- [x] The provider-neutral response budget supports automatic translation plus `max_tokens`, `max_completion_tokens`, or omit without creating a second Conversation budget.
- [x] Controlled end-to-end tests prove Test Connection and ordinary Generation against a generic exact fake endpoint without leaking secrets into DOM, transport errors, provenance, events, or logs.
