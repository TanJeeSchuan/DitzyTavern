# Decision Models over the System One wire

## Problem Statement

Memory judgment, Memory recall and Semantic Triggers can only ask Typesafe's hosted Jev. The endpoint is hardcoded, and the credential and model live in a Typesafe-only settings record beside, not inside, Connection Profiles. Since Jev launched, other Decision Models have appeared that speak the same `/v1/systemone` contract: Cloudflare's Clef and Clef Flash through OpenRouter, Laya through `laya-serve`, and models served by Ollama. A writer who wants a cheaper, faster, local or open-weights Decision Model cannot use one. A writer who already pays OpenRouter has to hold a second Typesafe account.

Two details of the current design also stop other models from working well. Memory admission depends on Jev's `confidence` statistic, which other vendors compute differently under the same name. The request bounds assume Jev's context, so a model that reads only about 2K tokens of state, as Clef does, ignores most of a scene without reporting it.

## Solution

Treat a Decision Model endpoint as a Connection Profile using a new System One API Format. Any HTTP endpoint that speaks `{model, state, questions}` → `{answers}` works: presets cover OpenRouter, TypeSafe and a blank endpoint for local servers. Memory Settings choose the Decision Model for judgment and recall. A new Semantic Trigger Settings record chooses Lore's. Each selection carries its own state token limit, which Lore uses to chunk its scene, recall uses to trim its scene, and extraction judgment enforces with a visible error. Responses are parsed leniently, and no decision reads `confidence`: Memory admission requires a minimum `retain` probability instead. The Typesafe settings record, its credential and the hardcoded endpoint are removed. See ADR-0047.

## User Stories

### Connecting Decision Models

1. As a writer, I want to add a Decision Model endpoint as a Connection Profile, so that its credential, headers and timeout are managed like every other connection.
2. As a writer, I want an OpenRouter preset for Decision Models, so that I can use Jev, Clef and Clef Flash with my existing OpenRouter key.
3. As a writer, I want a TypeSafe preset, so that I can call Jev directly with a TypeSafe key.
4. As a writer, I want a blank System One preset, so that I can point at `laya-serve`, Ollama or any other server that speaks the contract.
5. As a writer, I want to use a local HTTP address such as `http://localhost:8000/v1/`, so that I can run a Decision Model on my own machine.
6. As a writer, I want a request URL ending in `/` to have `systemone` appended, so that I can paste a base URL the way vendors document it.
7. As a writer, I want a request URL without a trailing `/` used exactly as written, so that I can reach a server mounted on a custom path.
8. As a writer, I want the credential to be optional, so that a keyless local server works.
9. As a writer, I want custom headers sent with every Decision Model request, so that I can pass gateway tokens or attribution headers.
10. As a writer, I want each System One profile to require a positive timeout, so that a hung endpoint never stalls Memory or a Generation indefinitely.
11. As a writer, I want to give a slow local server a longer timeout, so that it is not abandoned before it answers.
12. As a writer, I want discovered Decision Models listed from the profile's Models URL, so that I can pick a model ID instead of typing it.
13. As a writer, I want to pin model IDs on a System One profile, so that the models I use stay at the top of the picker.
14. As a writer, I want Test Connection to send one real yes/no question to the chosen model, so that I know the URL, key, model ID and response shape all work before Memory depends on them.
15. As a writer, I want Test Connection to report a response it cannot read as a failure with the reason, so that I find an incompatible server before it breaks a Generation.

### Memory

16. As a writer, I want Memory Settings to choose the Decision Model used for Memory judgment and recall, so that Memory does not depend on Lore's choice.
17. As a writer, I want Memory Settings to accept only a System One profile for that choice, so that I cannot select a chat or embeddings endpoint by mistake.
18. As a writer, I want to set the state token limit next to the model I choose, so that a short-context model such as Clef is never sent more state than it reads.
19. As a writer, I want a sensible default state token limit, so that Jev works without tuning.
20. As a writer, I want Memory extraction to report clearly when no Decision Model is chosen, so that I know why no Memories are saved.
21. As a writer, I want a Memory source whose judgment state exceeds the chosen limit to fail visibly, so that a Memory is never admitted from a judgment made on truncated evidence.
22. As a writer, I want Memory admission to require a minimum probability that the claim should be retained, so that the threshold means the same thing whichever Decision Model I use.
23. As a writer, I want that minimum to start at 0.6 and be editable, so that I can make Memory stricter or looser.
24. As a writer, I want recall to trim its scene to the chosen state token limit, so that recall still runs with a short-context model.
25. As a writer, I want Generation Details to name the Decision Model profile and model that judged recall, so that I can tell which model made each relevance decision.
26. As a writer, I want Generation Details to say whether that Decision Model was configured, so that a recall failure is easy to diagnose.
27. As a writer, I want retained Memory judgment evidence to keep each answer's probabilities and, when the model returns it, its confidence, so that I can inspect why a Memory was admitted.

### Semantic Triggers

28. As a lore author, I want to choose the Decision Model that judges Semantic Triggers separately from Memory's, so that I can use a fast model on every Generation and a larger one for Memory.
29. As a lore author, I want Semantic Triggers off when no Decision Model is chosen, so that turning them off is clearing one selection.
30. As a lore author, I want turning Semantic Triggers off to produce keyword-only matching with the existing explanation, so that the Lore Activation Record still says why.
31. As a lore author, I want the scene split into chunks that fit the chosen state token limit, so that a short-context model still reads the whole Lore Scan Window.
32. As a lore author, I want the probability threshold kept with the Semantic Trigger selection, so that all semantic matching settings are in one place.
33. As a lore author, I want the match tester to show each trigger's probability from the chosen Decision Model, so that I can tune triggers against the model I actually use.

### Compatibility and removal

34. As a writer, I want responses with extra fields such as `latency_ms`, `provider` or `usage.cost` accepted, so that compatible servers are not rejected for reporting more than Jev does.
35. As a writer, I want score answers without `confidence` or `legend` accepted, so that servers that omit them still work.
36. As a writer, I want choice probabilities rounded by the server accepted even when they do not sum to exactly one, so that rounding never fails a whole extraction batch.
37. As a writer, I want a response missing an answer, adding an unasked answer, or naming an option I did not offer rejected, so that a broken server never produces a silent wrong decision.
38. As a writer, I want the Typesafe Jev section gone from Connections, so that there is one place to configure every endpoint.
39. As a writer, I want any change to a Decision Model selection, its limit or its threshold to invalidate an inspected Prompt Plan, so that a sent Generation never uses judgments from a different model.

## Implementation Decisions

1. **System One API Format.** Connection Profiles gain a `system-one` API Format. Validation accepts it, and requires a positive timeout as it does for Embeddings. The request URL follows the existing resolution rule: a trailing `/` appends `systemone`; otherwise the URL is used as written. Any HTTP or HTTPS address is accepted. Fields that only describe chat requests keep their defaults and are ignored.
2. **Presets.** Add three presets, each with a 15,000 ms timeout:
   - OpenRouter Decisions: request URL `https://openrouter.ai/api/v1/`, Models URL `https://openrouter.ai/api/v1/models?output_modalities=decisions`, pinned `typesafe/jev-1.13`, `cloudflare/clef` and `cloudflare/clef-flash`.
   - TypeSafe: request URL `https://api.typesafe.ai/v1/`, pinned `jev-1.13.0`.
   - System One endpoint: blank.
3. **One Decision Model client.** A single server module replaces the Typesafe module. It resolves a selection (profile, model, state token limit) to an endpoint, an optional Bearer credential, the profile's custom headers and the profile's timeout. It builds and packs requests, sends them with the existing bounded fetch, and parses answers. The request byte bound, request token bound and 256 KiB response bound stay as they are. The state bound becomes the selection's state token limit.
4. **Lenient parsing, exact keys.** Unknown fields are ignored at the response and answer level. Choice requires `choice` and `probabilities`; score requires `score` and `probabilities`; noul requires `noul`. `confidence` and `legend` are optional. Each probability must be within 0 to 1, and choice probability keys must equal the offered options exactly. Probabilities are not required to sum to one. The answer key set must equal the question key set.
5. **Memory Settings.** Add the decision profile (nullable), the decision model and the decision state token limit (default 16,000). Replace the usefulness confidence gate with the retain probability minimum (0 to 1, default 0.6). The decision profile must use the System One API Format, mirroring the Embeddings check for the embedding profile, and a deleted profile is handled the same way as a deleted embedding profile.
6. **Memory judgment.** Judgment state is the source and its captured context. When the state exceeds the selection's limit, the source fails with a visible error and no partial collection is saved. Admission requires supported, correct, retain, and a `retain` probability at or above the minimum. Judgment evidence keeps per-answer probabilities and keeps confidence only when returned.
7. **Memory recall.** The recall scene is trimmed to the smaller of its existing 4,000-token bound and the selection's state token limit, and the trimming is reported as before. With no Decision Model chosen and candidates ready, recall stops prompt preparation with a visible error naming Memory Settings, as the missing credential does today. The Memory Activation Record replaces the Jev model and credential flag with the decision profile's name, the model and whether the selection is configured.
8. **Semantic Trigger Settings.** A revisioned singleton replaces Typesafe Settings. It holds the decision profile (nullable), the decision model, the decision state token limit (default 16,000) and the trigger threshold (0 to 1, default 0.5). No profile means Semantic Triggers are off. The Jev/Off mode, the credential columns and the Typesafe routes are removed; new routes serve the record with the same apply, conflict and invalid outcomes. Scene chunking uses the selection's limit.
9. **Preparation identity.** The Generation preparation fingerprint and capture revision include both selections, their limits and the threshold in place of the Jev model and Typesafe revision.
10. **Schema.** Drop the Typesafe settings table, create the Semantic Trigger Settings table, and add the Memory Settings columns, through a generated migration. No data is migrated.
11. **Client.** The Typesafe entry in Connections becomes a Semantic Triggers entry editing the new record. Memory Settings gain the Decision Model picker (System One profiles only), the state token limit and the retain probability minimum. Copy that says Jev when it means the role says Decision Model. The profile editor offers the System One API Format and its presets.
12. **Documentation.** Update the conversation-memory and lorebooks specs, the README files and the AGENTS.md E2E section to describe Decision Models instead of Typesafe-only configuration.

## Testing Decisions

1. Test public server behavior with real SQLite and a controlled fetch, as the existing Memory recall, Memory and connection-settings contract tests do. Assert outbound request URLs, headers, models and state sizes, and the saved or reported results. Do not assert table layout or private call sequences.
2. Connection Profiles: a System One profile with each preset saves; a non-positive timeout is invalid; URL resolution with and without a trailing `/`; Test Connection succeeds on a valid answer and fails with a reason on a malformed one; the credential header is absent when no credential is set and custom headers are sent.
3. Parsing, through the callers rather than in isolation: extra fields and missing score `confidence` and `legend` are accepted; probabilities that do not sum to one are accepted; missing, extra or unknown answers and options are rejected.
4. Memory: no decision selection blocks extraction with a visible reason; state over the limit fails the source with no partial collection; the `retain` probability gates admission regardless of `confidence`; recall sends a scene within the limit; a non-System One profile is rejected by Memory Settings; the Activation Record names the selection.
5. Semantic Triggers: no profile yields keyword-only matching with the existing explanation; a small state limit splits the scene into more requests and takes each trigger's highest score; the threshold applies; changing the selection changes the preparation fingerprint.
6. E2E: the fake recognises Decision Model calls by the `/systemone` path instead of the Typesafe host. The fixture that enables Jev creates a System One profile and selects it for Memory and Semantic Triggers. Existing Memory and Lore user flows keep passing.
7. Verify the Connections, Memory Settings and Semantic Triggers UI manually with playwright-cli. No component or snapshot tests.

## Out of Scope

- Adapters for endpoints that do not speak the contract: Cloudflare's REST envelope, native Python APIs such as Open-Jev's, and classifier-native models such as GLiClass. These are reached by wrapping them in a server that speaks the contract.
- Sending Images to Decision Models, although Clef and Liquid d1 accept them.
- Model discovery from catalogs that are not OpenAI-shaped.
- Per-model limits stored on a profile, and automatic detection of a model's context.
- Calibrating thresholds per vendor, or comparing model accuracy.
- Migrating existing Typesafe credentials or settings.

## Further Notes

- ADR-0047 records the decision, and supersedes the Typesafe settings and fixed deadline in ADR-0044.
- On OpenRouter, Jev reads 32K tokens of state. Clef on Workers AI reads about the first 2K tokens, so a Clef selection needs a state token limit near 2,000.
- Laya's base checkpoints score near chance on typed decisions without fine-tuning, according to its own model card. Supporting its server does not imply it is a good default.
- `confidence` is retained as evidence but never compared with a threshold, because vendors compute it differently.
