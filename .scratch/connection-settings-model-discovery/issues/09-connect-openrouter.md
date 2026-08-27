# 09 — Connect OpenRouter through its dedicated Adapter

**What to build:** Let a user create the approved OpenRouter Profile and use OpenRouter's dedicated AI SDK community Adapter for Test Connection and full ordinary Generation without hidden provider substitutions or invented attribution.

**Blocked by:** 06 — Generate a complete streamed Variant through the active Profile.

**Status:** complete

- [x] The OpenRouter AI SDK provider package is bundled at a version compatible with the selected main AI SDK generation.
- [x] The OpenRouter Preset copies Chat Completions, `https://openrouter.ai/api/v1/`, `https://openrouter.ai/api/v1/models`, Automatic Backend, and the OpenRouter Adapter into an editable Profile.
- [x] The Preset does not invent HTTP-Referer, X-OpenRouter-Title, or other optional attribution headers.
- [x] OpenRouter is an explicit AI SDK Adapter choice under Advanced settings and changing the URL never changes it implicitly.
- [x] The Adapter uses the Profile's dedicated credential, custom headers, resolved URL, model ID, and Conversation settings without environment provider-key overrides.
- [x] Test Connection and full ordinary Generation both work against controlled OpenRouter-shaped fake HTTP responses.
- [x] Recognized OpenRouter content, reasoning, finish, usage, and error outcomes normalize through the shared Model Client contract.
- [x] If any saved Adapter identifier is unavailable in the running application, the Profile remains preserved but unusable with an explicit error and no OpenAI Compatible fallback.
- [x] No dynamic provider packages, public adapter registry, or arbitrary Adapter-options JSON is introduced.
