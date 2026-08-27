# 10 — Discover, autocomplete, and pin model IDs

**What to build:** Let users refresh and retain the complete model catalog for autocomplete while independently curating a small ordered Pinned Models dropdown, then prove the full Preset-to-Generation journey in the browser.

**Blocked by:** 06 — Generate a complete streamed Variant through the active Profile; 09 — Connect OpenRouter through its dedicated Adapter.

**Status:** done

- [x] Refresh is available only when an exact Models URL is configured and sends one credentialed GET with Profile headers, no retry, and no redirect.
- [x] The common `data[].id` response is normalized by trimming whitespace, removing empty and exact duplicate IDs, preserving identifier spelling, and sorting case-insensitively for display.
- [x] A successful Refresh atomically replaces a persisted per-Profile Discovery Catalog that survives restart and remains outside the global Connection Settings revision.
- [x] A failed Refresh reports the failure and preserves the current catalog.
- [x] Applying a different Models URL clears the old catalog while preserving Pinned Models.
- [x] Blank Models URL disables Refresh but leaves generation and arbitrary free-text model entry available.
- [x] Disabled Refresh explains its current requirement on hover.
- [x] Opening the model combobox without a query shows the Profile's Pinned Models in star order.
- [x] Typing offers non-binding autocomplete across the complete Discovery Catalog while allowing any arbitrary non-empty model ID to be committed.
- [x] Each result exposes a star toggle; starring appends, un-starring removes, re-starring appends at the end, and selecting never changes pin state.
- [x] The composer model selector opens upward above its trigger.
- [x] Arbitrary IDs absent from discovery can be pinned.
- [x] DeepSeek Profiles seed `deepseek-v4-flash` and `deepseek-v4-pro`; OpenRouter Profiles seed `deepseek/deepseek-v4-flash`, `google/gemma-4-31b-it`, and `z-ai/glm-5.3` in the approved order.
- [x] Refresh never rewrites a Conversation's selected model or a Profile's Pinned Models.
- [x] Pure client-state and server contract tests cover catalog replacement/preservation, revision independence, autocomplete, free text, and star ordering.
- [x] One Playwright smoke flow creates a Profile from a Preset, sets a credential, Applies, Refreshes, pins/selects a model, runs Test Connection, activates the Profile, and completes one streamed Variant against a local fake provider.
- [x] The complete test suite, lint, build/type checking, security leak assertions, and focused browser smoke pass before this ticket is complete.
