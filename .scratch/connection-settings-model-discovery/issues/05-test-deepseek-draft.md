# 05 — Test a DeepSeek draft through the AI SDK Backend

**What to build:** Let a user verify the current unsaved DeepSeek Profile draft through one minimal real Chat Completions attempt using the AI SDK Backend and DeepSeek Adapter, without saving configuration or Conversation output.

**Blocked by:** 01 — Introduce the deep Model Client seam; 03 — Create a first secure DeepSeek Connection Profile.

**Status:** complete

- [x] One mutually compatible AI SDK package generation and the DeepSeek provider package are installed for the Bun server runtime.
- [x] Version one exposes Automatic and AI SDK Model Backend choices, with Automatic resolving to AI SDK before the request.
- [x] Version one exposes a concrete DeepSeek AI SDK Adapter and only the Chat Completions API Format.
- [x] A trailing-slash request URL appends `chat/completions`; a non-empty final path is exact; query parameters are preserved; the resolved destination is previewed before Apply.
- [x] Only HTTP and HTTPS are accepted; local and private-network destinations work; URL user information, fragments, and unsupported schemes are rejected.
- [x] Credentialed requests do not follow redirects or retry automatically.
- [x] Test Connection uses the current unsaved draft, existing kept secrets, and explicit replacement values without persisting, activating, revising, or creating a Message or Variant.
- [x] Test Connection requires a model ID, asks for a short `OK`-style response, uses a small output budget and short timeout, and warns that the provider may charge for it.
- [x] Test outcomes are transient and normalize success, authentication failure, endpoint failure, timeout, redirect, malformed response, and unavailable Adapter.
- [x] Conventional provider messages are sanitized; textual fallback is capped at 16 KiB; binary fallback reports only status, media type, and byte length; request and secret material never appears.
- [x] Controlled fake HTTP tests verify the actual destination, authentication, no retry/redirect, request invariants, and complete absence of durable Test Connection side effects.
