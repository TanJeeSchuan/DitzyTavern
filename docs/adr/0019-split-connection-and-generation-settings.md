# Split global connection settings from Conversation Generation Settings

The exact OpenAI-style Chat Completions endpoint URL, credentials, extra request headers, and output-token parameter name are application-global server configuration. The output-token parameter may be `max_tokens`, `max_completion_tokens`, or omitted; it changes only the wire representation of the Conversation-owned response budget. The server does not derive or append a provider path. Each Conversation owns its model selection, sampling parameters, context limit, response budget, and extra request body fields so its behavior remains independently tunable and does not change when another Conversation is configured.

Connection Settings may also contain an optional exact Models endpoint URL. A user-triggered refresh performs the standard OpenAI-style `GET`, reuses configured credentials and headers, and reads `data[].id`. The server never derives this URL from the Chat Completions endpoint, and discovery failure never blocks generation.

The Conversation model ID is selected through a dropdown populated by discovered IDs while always offering free-text entry. Discovery is advisory: a custom or previously selected ID remains valid application state even when it is absent from the latest result, and refreshing the list never rewrites Conversation settings.

Participants and Characters own no model or sampling configuration. Reassigning the model Control seat changes the responding identity and applicable Participant Definition without silently changing the endpoint, model, token limits, sampling parameters, or Request Overrides. The user may edit Conversation Generation Settings before starting the newly active Participant's Generation.

Generation Settings remain editable while sibling Variants are running. Each Generation snapshots its effective settings at start, and the resulting Variant records that snapshot for inspection. Connection credentials are neither copied into Variants nor exposed to clients.
