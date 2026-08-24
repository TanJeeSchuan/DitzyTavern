# Support editable one-shot prompt inspection

An optional Inspect Prompts mode will preview the exact provider-neutral Prompt Plan that the server would compile when the current draft Message is sent. Its panel exposes named blocks, normalized history, provider-role mapping, estimated token use, configured safety margin, and omitted context. It never presents the bundled tokenizer's estimate as an authoritative count for the remote model.

The user may edit that compiled plan for one specifically started Generation, whether it begins a response position or adds a sibling Variant. These edits do not mutate Participant Definitions, Conversation history, or provider configuration, and the Model Client still translates the plan rather than accepting raw provider JSON. A later Swipe compiles again from then-current configuration unless the user separately edits its preview. Normal Stop and Stop All controls remain available during the resulting Generation.

Manual edits may alter or remove normally mandatory blocks. The server validates only the edited plan's structure and configured context ceiling; invalid or oversized plans fail clearly rather than being silently repaired or truncated.

The exact captured Prompt Plan remains inspectable by all clients while its Generation is active. It is discarded when that Generation reaches a terminal state; version one does not provide post-hoc prompt auditing. The resulting Variant retains effective Generation Settings and outcome metadata, not a duplicate of the compiled history.
