# Connection Settings and Model Discovery

Status: ready-for-agent

## Problem Statement

DitzyTavern does not yet have a durable, user-facing way to configure model connections. A user cannot save multiple provider accounts, activate one globally, keep provider credentials out of Conversation state, discover available model IDs, or choose between a generic OpenAI-compatible transport and provider-specific AI SDK behavior. The current Generate workflow accepts an injected generation function, but there is no production Model Client that turns a provider-neutral Prompt Plan into a normalized streamed Generation.

Users need Connection Settings that work for ordinary hosted providers, OpenRouter, DeepSeek, local servers, LAN endpoints, and unusual OpenAI-compatible paths without exposing credentials to the browser after storage. The feature must remain smaller than a general provider-plugin system, must not freeze the still-evolving Prompt Compiler, and must preserve DitzyTavern's existing Conversation, Message, Variant, Control, and revision semantics.

## Solution

Add application-global Connection Settings containing multiple editable Connection Profiles. Profiles are created from bundled Connection Presets, store shared endpoint and transport configuration, and use one active Profile for every newly started Generation. Keep Conversation-owned model and generation parameters separate from global connection details.

Put all model transport behind one deep Model Client. Version one uses Vercel AI SDK as its only Model Backend and bundles three explicit AI SDK Adapters: OpenAI Compatible, DeepSeek, and OpenRouter. Implement only the OpenAI Chat Completions API Format. Preserve OpenAI Responses, Anthropic Messages, Native transport, and additional backend implementations as explicit deferrals.

Encrypt each Profile's dedicated credential and custom-header values as one AES-256-GCM payload in SQLite. Manage the master key through `CONNECTION_SECRET_KEY`, generating and durably adding it to the Git-ignored local `.env` on first startup when no injected value exists. Never return stored secret plaintext to the client.

Provide advisory model discovery through an explicitly configured Models URL. Persist the last successful per-Profile Discovery Catalog for autocomplete, while maintaining a smaller user-editable Pinned Models list for the default dropdown. Keep arbitrary free-text model IDs valid.

Use offline atomic Apply for configuration and a separate explicit Test Connection action that performs one minimal real Generation. Integrate ordinary full Message generation through the Model Client while treating the current Prompt Plan as opaque, so this work does not lock down unfinished Prompt Compiler semantics.

## User Stories

1. As a DitzyTavern user, I want to open global Connection Settings, so that I can configure model access independently of any Conversation.
2. As a new user, I want DitzyTavern to work with zero Connection Profiles, so that I can use non-generation features before configuring a provider.
3. As a user with no Connection Profile, I want Generate actions to explain that model generation is unconfigured, so that the missing setup is clear.
4. As a user, I want to create a Connection Profile from a Preset, so that common provider fields are filled automatically.
5. As a user, I want Presets to create editable Profiles rather than permanent managed objects, so that I can customize endpoints and settings.
6. As a user, I want later application updates to leave my existing Profiles unchanged, so that new Preset defaults do not silently alter my connections.
7. As a user, I want to create multiple global Connection Profiles, so that I can keep separate accounts, proxies, and providers.
8. As a user, I want every Profile to have a required case-insensitively unique display name, so that I can distinguish connections reliably.
9. As a user, I want exactly one Profile active when Profiles exist, so that new Generations have an unambiguous connection.
10. As a user creating the first Profile, I want it to become the active connection, so that generation becomes configured without another mandatory step.
11. As a user creating another Profile, I want my current active Profile to remain active until I explicitly switch, so that creation does not redirect later Generations unexpectedly.
12. As a user, I want to activate another Profile globally, so that later Generations use it without rewriting Conversation Generation Settings.
13. As a user, I want deletion of the active Profile to require a replacement unless it is the final Profile, so that activation remains valid.
14. As a user, I want deleting the final Profile to return the application to the unconfigured state, so that removing model access is supported.
15. As a user, I want a DeepSeek Preset, so that official DeepSeek endpoints, models, and adapter behavior are ready to edit.
16. As a user, I want an OpenRouter Preset, so that OpenRouter generation and discovery endpoints are ready to use after I provide a key.
17. As a user, I want a Generic OpenAI Compatible Preset with blank URLs, so that I can configure local, proxied, or unusual endpoints.
18. As an advanced user, I want to see the Model Backend under Advanced settings, so that the transport implementation is explicit.
19. As an advanced user, I want `Automatic` and `AI SDK` Model Backend choices, so that the stored configuration remains forward-compatible while v1 resolves both to AI SDK.
20. As an advanced user, I want to select a bundled AI SDK Adapter, so that provider-specific request and stream behavior is explicit.
21. As a user, I want Presets to choose a concrete AI SDK Adapter, so that no hidden URL guessing is required.
22. As a user editing a Profile URL, I want the selected Adapter to remain unchanged, so that changing destinations never silently changes protocol behavior.
23. As a user opening a Profile saved by a newer app version, I want an unavailable Adapter reported explicitly, so that DitzyTavern does not silently use a different transport.
24. As a user, I want a request URL ending in `/` treated as a base URL, so that conventional Chat Completions endpoints require minimal typing.
25. As a user, I want DitzyTavern to append `chat/completions` to a base request URL, so that URLs such as `https://api.deepseek.com/` resolve conventionally.
26. As a user, I want a request URL with a non-empty final path segment used exactly, so that endpoints such as `/generate` are supported.
27. As a user, I want to preview the resolved request URL before Apply, so that the base-versus-exact rule is visible.
28. As a user, I want HTTP and HTTPS local or private-network endpoints accepted, so that local and LAN model servers work.
29. As a user, I want unsupported schemes, URL user information, and fragments rejected structurally, so that invalid transport targets are caught before saving.
30. As a user, I want query parameters preserved as ordinary visible configuration, so that unusual non-secret endpoints remain expressible.
31. As a user, I want DitzyTavern not to follow model-endpoint redirects, so that the saved resolved URL remains the actual credentialed destination.
32. As a user, I want an optional exact Models URL independent from the request URL, so that discovery is explicit rather than guessed.
33. As a user with no Models URL, I want generation and free-text model entry to remain available, so that discovery is never mandatory.
34. As a user, I want Refresh to call the configured Models URL with my Profile authentication, so that private catalogs can be discovered.
35. As a user, I want a successful Refresh to replace the cached model IDs, so that autocomplete reflects the latest successful result.
36. As a user, I want a failed Refresh to preserve the previous catalog, so that a transient failure does not empty model selection.
37. As a user, I want the Discovery Catalog to survive server restarts, so that autocomplete remains useful without refreshing every launch.
38. As a user, I want changing the Models URL to clear its old Discovery Catalog, so that models from another endpoint are not presented as current.
39. As a user, I want Refresh not to invalidate my Profile draft, so that cache updates do not create configuration revision conflicts.
40. As a user, I want discovered model IDs trimmed, deduplicated, and sorted predictably while preserving their actual spelling, so that autocomplete is clean without changing provider identifiers.
41. As a user, I want a searchable model combobox, so that hundreds of discovered models remain manageable.
42. As a user, I want opening the model combobox to show a small Pinned Models list, so that my preferred choices are immediately available.
43. As a user, I want typing to autocomplete across the full Discovery Catalog, so that every available discovered model remains accessible.
44. As a user, I want to commit an arbitrary free-text model ID, so that discovery never becomes an allowlist.
45. As a user, I want a star toggle beside model choices, so that I can maintain my Pinned Models while searching.
46. As a user, I want starring a model to append it to the pinned order, so that the dropdown reflects the order in which I curated it.
47. As a user, I want un-starring a model to remove it without selecting another model, so that selection and curation remain independent.
48. As a user, I want selecting a model not to pin it automatically, so that experiments do not clutter my curated list.
49. As a user, I want to pin an arbitrary model ID absent from discovery, so that custom models can remain convenient.
50. As a DeepSeek user, I want V4 Flash and V4 Pro initially pinned, so that the current supported models are immediately selectable.
51. As an OpenRouter user, I want DeepSeek V4 Flash, Gemma 4 31B, and GLM 5.3 initially pinned, so that the Preset begins with the chosen curated set.
52. As a user, I want to provide a dedicated credential as a password-style field, so that standard Bearer authentication is easy to configure.
53. As a user creating a Profile, I want its initial credential committed atomically with the Profile, so that setup does not leave a half-created secret record.
54. As a returning user, I want the client to see only whether a credential is configured, so that stored plaintext never returns to the browser.
55. As a user, I want a separate Set or Update action for the dedicated credential, so that ordinary Profile Apply cannot accidentally erase it.
56. As a user, I want credential Reset to require separate confirmation, so that secret deletion is deliberate.
57. As a user, I want custom-header keys visible while their stored values remain redacted, so that I can understand the header shape without retrieving secrets.
58. As a user, I want explicit keep, replace, and remove operations for custom-header values, so that redacted editing is unambiguous.
59. As a user, I want header values to remain absent from the DOM after storage, so that redaction is enforced by the server contract rather than CSS.
60. As a user, I want custom header names validated and compared case-insensitively, so that duplicate wire headers are not created accidentally.
61. As a user with unusual authentication, I want custom headers to replace standard Authorization when explicitly configured, so that nonstandard endpoints remain usable.
62. As a user, I want transport-owned headers rejected, so that invalid Host, Content-Length, or Transfer-Encoding overrides cannot be saved.
63. As a user, I want API keys and header values encrypted in the database, so that a copied database alone does not expose plaintext credentials.
64. As a local user, I want a master key generated automatically on first startup, so that secure local setup requires no manual provisioning.
65. As a deployment operator, I want an injected `CONNECTION_SECRET_KEY` to take precedence, so that deployment secret management controls the master key.
66. As a deployment operator, I want malformed or unwritable master-key configuration to fail startup descriptively, so that the app never runs with ephemeral or unusable encryption.
67. As a user, I want losing or replacing the master key to fail closed, so that DitzyTavern never silently resets encrypted credentials.
68. As a user, I want Profile Apply to validate and save without contacting the provider, so that offline or temporarily unavailable configurations can be retained.
69. As a user, I want Apply to atomically commit non-secret Profile data and custom-header secret operations, so that no half-applied configuration becomes authoritative.
70. As a user, I want one global Connection Settings revision, so that concurrent edits and activation changes have a simple conflict model.
71. As a user whose draft is stale, I want Apply rejected while preserving my local draft and refreshed authoritative state, so that I can compare and retry manually.
72. As a user, I want Test Connection separate from Apply, so that network verification is explicit.
73. As a user, I want Test Connection to exercise the current unsaved draft, so that I can verify edits before persisting them.
74. As a user, I want Test Connection to reuse existing redacted secrets and explicit replacement drafts, so that the test matches the form without exposing stored values.
75. As a user, I want Test Connection to require a model ID and request a very short response, so that it verifies real generation with minimal cost.
76. As a user, I want Test Connection to disclose that it contacts the provider and may incur a charge, so that the action is informed.
77. As a user, I want Test Connection to use no automatic retries and a short timeout, so that one click represents one bounded provider attempt.
78. As a user, I want Test Connection results to remain transient, so that failure does not become a stale persisted validity flag.
79. As a user starting a normal Generation, I want DitzyTavern to snapshot the active Profile, Connection Settings revision, resolved Backend and Adapter, and effective Generation Settings, so that later edits cannot alter the running attempt.
80. As a user changing the active Profile during a running Generation, I want the running attempt to finish on its original snapshot, so that it never switches provider mid-stream.
81. As a user, I want a failed model request never retried automatically, so that ambiguous failures cannot create duplicate charges.
82. As a user, I want `Automatic` Backend resolution fixed before the outbound request, so that it never becomes a failover policy.
83. As a user, I want visible text streamed into the current Variant, so that replies appear incrementally.
84. As a user, I want recognized separate reasoning streamed and stored separately, so that it can be presented as collapsible Reasoning Content.
85. As a user, I want unknown reasoning shapes ignored while visible content continues, so that optional provider quirks do not fail otherwise usable Generations.
86. As a user, I want cancellation and inactivity timeout to stop only the affected Generation, so that the Conversation remains usable.
87. As a user, I want a Generation with no visible or reasoning output removed after failure, so that empty provisional Variants do not remain.
88. As a user, I want a partially streamed Variant preserved as interrupted, so that received writing is not lost.
89. As a user, I want a length-limited finish represented explicitly, so that truncation is distinguishable from a normal stop.
90. As a user, I want safe Generation provenance stored per Variant, so that sibling Variants can show which settings and connection revision produced them.
91. As a user, I want provenance to exclude secrets, headers, and connection URLs, so that inspection cannot leak authentication or infrastructure details.
92. As a user, I want conventional provider errors sanitized for display, so that actionable messages are available safely when possible.
93. As an advanced user, I want a bounded raw textual error fallback, so that unusual provider failures remain diagnosable.
94. As a user, I want binary or enormous error bodies summarized rather than injected into the UI, so that error handling remains bounded.
95. As a user, I want my Conversation's model, sampling, context, response budget, and Request Overrides remain Conversation-owned, so that switching global Profiles does not rewrite writing preferences.
96. As a user, I want Request Overrides namespaced by API Format, so that future Format switches do not transmit incompatible saved fields.
97. As a user, I want one provider-neutral response budget translated by the active Profile, so that Prompt Compiler budgeting and remote output limits share one source.
98. As a user, I want Profile-specific output-token representation choices, so that compatible endpoints can receive `max_tokens`, `max_completion_tokens`, or no remote limit.
99. As a developer, I want Workflows and Conversations isolated from AI SDK types, so that provider libraries remain replaceable inside the Model Client.
100. As a developer, I want the current Prompt Plan treated as opaque by this feature's integration tests, so that unfinished Prompt Compiler features remain free to evolve.

## Implementation Decisions

- Add a deep Model Client module whose small provider-neutral interface accepts an opaque Prompt Plan plus effective Generation and Connection snapshots and returns an asynchronous stream of normalized events. Workflows and Conversation modules must not import AI SDK types.
- The normalized Model Client contract covers visible content, optional recognized Reasoning Content, cancellation, no automatic retry, stream-inactivity timeout, normalized finish and error outcomes, arbitrary model IDs, usage when available, and advisory discovery.
- Version one ships only the AI SDK Model Backend. The Profile persists `Automatic` or `AI SDK`; `Automatic` resolves to AI SDK before the request. Native and other Backends are reserved but unimplemented.
- Add an explicit AI SDK Adapter field under Advanced settings. It has no Automatic value and uses stable application identifiers rather than package names or versions. The closed v1 set is OpenAI Compatible, DeepSeek, and OpenRouter.
- Bundle the main `ai` package, `@ai-sdk/openai-compatible`, `@ai-sdk/deepseek`, and `@openrouter/ai-sdk-provider`. Adapter loading is compile-time application behavior; Profiles cannot name arbitrary npm modules or dynamically load code.
- The OpenRouter adapter is an OpenRouter-maintained AI SDK community provider. Its third-party maintenance boundary is accepted for v1.
- If a persisted Adapter is unavailable after an application downgrade or packaging change, preserve the Profile but reject use with an explicit Adapter-unavailable outcome. Never substitute the generic adapter.
- Expose no arbitrary Adapter-options JSON in v1. Conversation Request Overrides carry request-body extensions; Profile custom headers carry transport extensions. Add typed adapter options only when a concrete capability requires them.
- Implement only the OpenAI Chat Completions API Format. Keep OpenAI Responses and Anthropic Messages as reserved vocabulary but unavailable in the UI and rejected as unsupported by v1 Backends.
- A Profile owns API Format, request URL, optional Models URL, dedicated credential, custom headers, output-token representation, timeout, Model Backend preference, AI SDK Adapter, Pinned Models, and any namespaced Backend Options.
- A Conversation continues to own model ID, sampling parameters, context limit, response budget, and per-Format Request Overrides. Conversations never bind to a Profile; they use whichever global Profile is active when a Generation starts.
- Connection Settings form one application-global revisioned aggregate. When Profiles exist, exactly one is active. The first Profile becomes active. Creating later Profiles does not change activation. Deleting the active Profile requires a replacement unless it is the final Profile.
- Profile display names are required, normalized consistently with existing name behavior, and unique under case-insensitive comparison.
- Connection Presets are application-owned factories. Selecting one copies defaults into an independently editable Profile. Existing Profiles never synchronize with later Preset changes.
- Bundle exactly three v1 Presets:
  - DeepSeek: Chat Completions; request URL `https://api.deepseek.com/`; exact Models URL `https://api.deepseek.com/models`; Automatic Backend; DeepSeek Adapter; pinned `deepseek-v4-flash`, then `deepseek-v4-pro`.
  - OpenRouter: Chat Completions; request URL `https://openrouter.ai/api/v1/`; exact Models URL `https://openrouter.ai/api/v1/models`; Automatic Backend; OpenRouter Adapter; pinned `deepseek/deepseek-v4-flash`, `google/gemma-4-31b-it`, then `z-ai/glm-5.3`.
  - Generic OpenAI Compatible: Chat Completions; blank request and Models URLs; Automatic Backend; OpenAI Compatible Adapter; no pinned models.
- Presets do not add optional attribution headers. OpenRouter `HTTP-Referer` and `X-OpenRouter-Title` remain user-configured custom headers.
- Resolve request URLs deterministically from the parsed pathname. A pathname ending in `/` is a base and receives `chat/completions`; a pathname with a non-empty final segment is exact and remains unchanged. Preserve query parameters. Show the resolved URL before Apply.
- AI SDK Adapters must honor the resolved exact destination. Where a provider package normally appends its own path, the Model Client may use the package's custom fetch seam to force the already-resolved Profile URL without changing request/stream translation.
- Permit only HTTP and HTTPS request and Models URLs. Permit loopback and private-network destinations. Reject URL user information, fragments, and all other schemes.
- Do not follow redirects for generation, Test Connection, or discovery. Report redirects descriptively without forwarding credentials or custom headers.
- Query parameters are ordinary visible Profile configuration. Do not detect, warn about, encrypt, or redact possible query credentials. Users accept the exposure boundary if they put secrets in a URL.
- Persist Connection Settings and Profiles in dedicated SQLite state rather than Conversation data. Store the active Profile relationship and global revision transactionally.
- Store one encrypted secret payload per Profile containing the dedicated credential and custom-header values. Secret state is server-owned application configuration and never Conversation state.
- Use `node:crypto` AES-256-GCM with exactly 32 random master-key bytes represented as Base64, a unique cryptographically random 12-byte nonce per write, a 16-byte authentication tag, and authenticated additional data binding schema version and stable Profile identity.
- Store encryption format version and key identifier beside nonce, ciphertext, and authentication tag. Version one uses one active key and provides no key-rotation workflow.
- Read `CONNECTION_SECRET_KEY` from an injected environment or deployment secret when present. It takes precedence and must decode to exactly 32 bytes. A malformed explicit value fails startup and is never replaced.
- When no key exists on first local startup, generate one, preserve existing `.env` contents, and durably add exactly one `CONNECTION_SECRET_KEY` entry to the Git-ignored `.env`. Use the generated key for the current process. If generation or durable writing fails, fail startup before accepting work with a descriptive message that never prints key material.
- Never store the master key in SQLite, return it to the client, or log it. Local backup requires `.env` alongside the database; deployments back up their injected secret. Losing or replacing the key makes stored credentials unrecoverable and requires credential resets.
- The encryption boundary protects a database or backup copied without the master key. It does not protect against a compromised backend process or host that can read both.
- Profile creation may atomically include the initial dedicated credential. After creation, expose only configured/unconfigured state. Use separate Set or Update and confirmed Reset actions; ordinary Profile Apply never changes the dedicated credential.
- Custom-header APIs return only header keys, display casing, and configured state. Stored values never return to the browser. Accept explicit keep, replace, and remove operations. Use `json-edit-react` against the redacted projection and new replacement drafts, not against plaintext fetched from the server.
- Header names must be valid HTTP header tokens and unique under case-insensitive comparison while preserving display casing. Reject transport-owned names such as Host, Content-Length, and Transfer-Encoding. Explicit custom Authorization may replace standard Adapter authentication.
- Do not support external-provider credentials from environment variables in v1. Every Profile resolves its provider authentication only from encrypted Profile secret state. `CONNECTION_SECRET_KEY` is the application master key, not a provider credential override.
- Add a persisted per-Profile Discovery Catalog separate from editable Connection Settings. It does not increment the global revision and Refresh cannot invalidate a Profile draft.
- Refresh issues one GET to the exact Models URL, reusing the Profile's dedicated credential and custom headers, and accepts the common `data[].id` response shape. It uses no redirect and no automatic retry.
- On successful Refresh, trim surrounding whitespace, remove empty IDs, remove exact duplicates, preserve original identifier spelling, sort case-insensitively for display, and atomically replace the catalog. On failure, preserve the previous catalog and report the failure.
- Applying a different Models URL clears the old catalog while preserving Pinned Models. Blank Models URL disables Refresh but never generation or free-text entry.
- Each Profile owns ordered Pinned Models. Presets seed the list. Starring appends an ID; un-starring removes it; re-starring later appends it at the end. Selection never changes pinning. Any non-empty arbitrary ID can be pinned. Refresh never rewrites pins.
- The model control is a searchable combobox with two presentation modes: without a query it shows Pinned Models in star order; with a query it autocompletes non-binding suggestions from the complete Discovery Catalog. It always accepts arbitrary free text and needs no saved autocomplete preference.
- Connection Profile Apply performs structural validation and persistence only, with no network call. It atomically replaces the Profile's ordinary data and custom-header secret operations under the expected global revision.
- Test Connection is separate and optional. It evaluates the current unsaved Profile draft without persisting, activating, or revising it. Redacted secrets use keep; explicit header replacements may be included. A dedicated credential must already have been created or updated through its separate secret action.
- Test Connection requires a model ID, sends one real minimal Chat Completions request asking for a short `OK`-style response with a small output budget, uses no retry and a short timeout, warns that it contacts the provider and may incur cost, and returns only a transient normalized outcome.
- Conversation Request Overrides remain namespaced by API Format. Merge the active Chat Completions object late. Permit unknown provider-specific body fields and ordinary parameter overrides, but prevent structural override of messages, model, stream, n, and Format-owned output-limit fields. Continue rejecting tool calling, audio, and unsupported modalities; allow textual response formatting such as JSON mode.
- Keep one Conversation-owned provider-neutral response budget. Automatic translation uses the AI SDK common `maxOutputTokens` behavior. Chat Completions Profiles may choose `max_tokens`, `max_completion_tokens`, or omit. Omission retains local budgeting while sending no remote limit.
- Force one response choice per Generation. One Generation creates at most one new Variant.
- Preserve the Prompt Plan as an opaque provider-neutral input at the Connection Settings/Model Client boundary. This spec does not complete or freeze block composition, history selection, role placement, or other Prompt Compiler WIP behavior.
- The existing Chat Completions mapping remains the current v1 transport rule: use broadly compatible system, user, and assistant roles and do not introduce the developer role. Further Prompt Compiler capabilities may revise how the opaque plan is produced without changing the Connection Settings domain.
- Resolve the active Profile, Connection Settings revision, Backend, Adapter, and effective Generation Settings before each outbound ordinary Generation. Never fall through to another Backend or Adapter after a request begins.
- Snapshot safe generation provenance per Variant because sibling Variants can use different settings or Profile revisions. Exclude credentials, header values, and connection URLs from provenance and client inspection.
- No automatic model retries. A failure before any visible Content or Reasoning Content removes the empty provisional Variant; a failure after either output persists the Variant as interrupted. A user-started Swipe is the explicit retry.
- Support user cancellation and a configurable stream-inactivity timeout, default 120 seconds and allow increase or disable. There is no total-duration timeout while recognized SSE activity continues. Valid deltas, reasoning, usage, and keepalive comments reset inactivity; arbitrary partial bytes do not.
- Normalize recognized provider reasoning as separate Reasoning Content. If an Adapter cannot recognize a provider-specific reasoning shape, continue visible content and omit separate reasoning instead of failing. Do not return Reasoning Content in later prompts in v1.
- Normalize `finish_reason: length` as a length-limited terminal outcome while retaining compact raw finish metadata. Do not auto-continue.
- Error normalization first extracts and sanitizes a conventional provider message. If extraction fails, return at most the first 16 KiB of a textual or JSON response body and mark truncation. For binary or unsupported media, report status, media type, and byte length. Never return response headers, request bodies, credentials, or configured header values, and do not log raw failures by default.
- The Connection Settings UI follows the existing project design system. Profiles, activation, Preset creation, Apply, Test Connection, credential actions, discovery, Pinned Models, and Advanced fields must expose the domain concepts directly without leaking AI SDK types.

## Testing Decisions

- Prefer tests at external behavior seams. Assert commands, HTTP responses, persisted snapshots, normalized events, and visible client state rather than private classes, helper calls, encryption library call order, or SDK internals.
- Use the server HTTP contract as the primary high seam. Construct the routes with an in-memory SQLite database, deterministic master key, and injected fake outbound fetch or fake provider endpoint. Exercise Profile creation, activation, revision conflicts, credential status, redacted headers, Apply, Test Connection, discovery, pins, URL policy, Adapter selection, and normalized failures through requests and responses.
- Follow the existing transport-test pattern: domain matrices live behind the module seam, while route tests cover request/response contracts and typed error mapping. Existing Character Library and Conversation contract tests are the prior art.
- Test the Connection Settings module directly only for state matrices that would be noisy through HTTP: zero/one/many Profile activation, deletion replacement, case-insensitive names, Preset copying, atomic revision behavior, catalog separation, and database constraints. Use an in-memory database like existing Conversation and Character Library module tests.
- Test encryption and key bootstrap through narrow public module behavior. Cover 32-byte Base64 validation, first-start generation, preservation of existing `.env` content, injected-key precedence, write failure, startup fail-fast behavior, unique nonces, successful round trip, AAD row-swap failure, tampered ciphertext/tag failure, wrong-key failure, and absence of plaintext in SQLite. Do not assert random bytes or internal crypto call sequences.
- Test each AI SDK Adapter with controlled fake HTTP rather than live providers. Assert the externally visible resolved destination, authentication/header behavior, Chat Completions request invariants, no retry, no redirect, cancellation, text/reasoning normalization, finish mapping, bounded errors, and exact-path support. Do not make paid or internet-dependent test calls.
- Keep one full ordinary Generation integration seam through the existing Generate workflow. Feed an opaque current Prompt Plan into a fake normalized Model Client stream and assert the plan is passed unchanged, the active connection/settings snapshot is fixed at start, text/reasoning events produce the correct Variant outcome, interruption rules hold, and safe provenance is stored per Variant.
- Do not use Connection Settings tests to specify exhaustive Prompt Plan blocks, role composition, history selection, macro expansion, or future Prompt Compiler features. Existing Prompt Compiler tests own those WIP semantics.
- Test Test Connection separately from ordinary Generation. Assert its minimal request, short output budget, timeout/no-retry behavior, draft usage, transient result, and complete absence of Message, Variant, activation, revision, or persisted Profile mutation.
- Add pure client-state tests following existing story and information reducer prior art. Cover Profile drafts, conflict preservation, redacted keep/replace/remove operations, credential configured states, resolved-URL preview, Advanced fields, Discovery Catalog suggestions, star ordering, arbitrary model IDs, Refresh failure preservation, and adapter-unavailable presentation.
- Add one Playwright happy-path smoke flow using fake/local provider responses: create a Profile from a Preset, set a credential, Apply, Refresh, pin a model, Test Connection, activate the Profile, choose a model in a Conversation, and complete one streamed Variant. Use this as wiring confidence, not as the exhaustive state matrix.
- Add migration/schema integration tests for global revision, active-Profile invariants, case-insensitive Profile name uniqueness, secret payload cascade behavior, per-Profile catalog/pins, and Variant provenance. Database constraints should back hard invariants where practical.
- Verify that client-facing payloads, SSE events, logs captured by tests, Variant provenance, snapshots, and exports contain no credential or custom-header plaintext.
- Run the complete Bun test suite, lint, type checking through the normal build, and the focused Playwright smoke before closing the feature. Add teardown behavior for any new seed data if Presets or fixtures are introduced through the existing database seed path.

## Out of Scope

- OpenAI Responses request, prompt, stream, reasoning, and output-budget shaping.
- Anthropic Messages request, prompt, stream, authentication, and output-budget shaping.
- Native HTTP Model Backend implementation.
- pi-ai or any other example Backend.
- Automatic fallback or retry between Backends, Adapters, Profiles, or providers.
- Automatic retry of one provider request for any transport or stream failure.
- Dynamic provider plugins, arbitrary npm package loading, a public provider registry, or a public adapter SDK.
- Arbitrary AI SDK provider-options JSON. New options require a concrete typed feature decision.
- Tool calling, tool execution, audio, images, and other non-text output modalities.
- Returning Reasoning Content to later prompts.
- Completing or redesigning the Prompt Compiler, Prompt Plan, context selection, or future prompt blocks.
- Deriving a Models URL from a request URL.
- Durable refresh history, timestamps, stale badges, model pricing, capabilities, context lengths, or full provider metadata. The Discovery Catalog stores IDs only.
- Credential detection, warnings, encryption, or redaction for URL query parameters.
- Environment-variable overrides for external-provider API keys.
- Master-key export/import UI, passphrase derivation, multiple active master keys, or key rotation workflow.
- Protecting secrets from a compromised backend process or host that possesses both the master key and database.
- Following HTTP redirects for generation, Test Connection, or discovery.
- Persisting Test Connection validity or health history.
- Automatic mutation of existing Profiles when bundled Presets change.
- Automatic pinning based on model selection, recency, popularity, or discovery results.
- Provider-specific attribution headers added without user configuration.

## Further Notes

- The governing architectural records are ADR-0015, ADR-0019, ADR-0022, and ADR-0023. The Model connection glossary defines Connection Preset, Connection Profile, API Format, Model Backend, AI SDK Adapter, Connection Secret, Discovery Catalog, and Pinned Models.
- The Profile secret payload and non-secret Profile state may share one SQLite transaction while remaining separate representations. Plaintext exists only transiently in backend memory when applying authentication or editing the encrypted payload.
- The local `.env` is already excluded from Git. Production environments should prefer injected deployment secrets even though local first-start bootstrap writes `.env`.
- `json-edit-react` was selected to avoid building a JSON tree editor, but DitzyTavern's safe redacted projection and secret-operation contract remain authoritative if the UI dependency changes.
- DeepSeek's current official API advertises `deepseek-v4-flash` and `deepseek-v4-pro`, uses `https://api.deepseek.com/chat/completions`, and exposes `GET /models` with `data[].id`.
- OpenRouter's current API uses `https://openrouter.ai/api/v1/chat/completions` and `https://openrouter.ai/api/v1/models`; the selected curated OpenRouter IDs were verified against its live catalog during design.
- Package versions must be selected as one mutually compatible AI SDK generation. Do not mix package major versions intended for different AI SDK protocol versions.
- This spec is ready to decompose into blocker-aware tracer-bullet tickets; it is not itself an implementation ticket.
