# Ask Decision Models over the System One wire

Memory judgment, Memory recall and Semantic Triggers ask a Decision Model through any HTTP endpoint that speaks Jev's `POST …/v1/systemone` contract: `{model, state, questions}` in, `{answers}` keyed by question id out, with `choice`, `score` and `noul` answers. That contract, not Typesafe's service, is the dependency. OpenRouter serves Jev and Cloudflare's Clef over it, and `laya-serve` and Ollama serve open models over it, so one transport covers them all. This supersedes the Typesafe settings in [ADR-0044](0044-judge-semantic-triggers-with-jev.md): the application-wide Typesafe credential, the Jev model and the Jev/Off mode.

Decision Models are reached through Connection Profiles using the System One API Format. A request URL ending in `/` gets `systemone` appended, so an OpenRouter profile uses `https://openrouter.ai/api/v1/`. Memory Settings choose the Decision Model for both judgment and recall. Semantic Trigger Settings choose Lore's and hold its threshold; when no profile is selected, Semantic Triggers are off and Generations use keyword-only matching. Each selection is a profile, a model and a state token limit. The limit belongs to the selection rather than the profile because one endpoint serves models that read very different amounts of state: on OpenRouter, Jev reads 32K tokens and Clef only about the first 2K. Lore splits its scene into chunks that fit the limit, recall trims its scene to the limit, and extraction judgment fails with a visible error instead of being judged on truncated state.

Only endpoints that already speak the contract are supported. DitzyTavern carries no adapters: Cloudflare's REST envelope, native Python APIs such as Open-Jev's, and classifier-native models such as GLiClass are reached by wrapping them in a server that speaks the contract. Clef is reached through OpenRouter rather than Workers AI's REST endpoint. Responses are read leniently: unknown fields are ignored at every level, score `confidence` and `legend` are optional, and choice probabilities are not required to sum to one. The set of answer keys must still match the questions exactly.

`confidence` never drives a decision, because vendors compute it differently while giving it the same name and range. Decisions read only probabilities and scores. Memory admission therefore requires the `retain` probability to meet a minimum, initially 0.6, instead of the usefulness confidence gate.

## Considered Options

- A singleton Decision Settings record with its own base URL and credential: rejected because it would be a second secret store next to Connection Profiles, and it would force one model on every caller.
- Unwrapping Cloudflare's `{result, success}` envelope through a profile adapter: rejected once OpenRouter served Clef over the plain contract.
- One global request bound fitted to Jev: rejected because a model with a smaller window would ignore part of the state without reporting it.
- A state token limit per Connection Profile: rejected because mixing Jev and Clef through one OpenRouter key would need two profiles holding the same credential.

Each request's deadline is its profile's timeout, which must be positive; the presets use fifteen seconds. This replaces ADR-0044's fixed fifteen-second deadline so that a slow local server can be given longer without a code change.

Everything else in ADR-0044 stands: one `noul` question per distinct trigger, a trigger's score being its highest across chunks, at most two concurrent requests, and whole-Generation keyword-only fallback on any failure.
