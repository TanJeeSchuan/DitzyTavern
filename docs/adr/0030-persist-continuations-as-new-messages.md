# Persist continuations as new Messages

A Continuation Generation creates a new model-authored Message with its own first Variant instead of appending text to the preceding selected Variant. The Prompt Plan carries a provider-neutral continuation intent so each model adapter can shape a compatible request without inserting a fake Human-authored Message into Conversation history.

This deliberately differs from SillyTavern's append behavior. A new Message preserves the existing relationship between one Generation attempt, one Generated Variant, and one set of provenance and outcome metadata. Continuing never rewrites the content or provenance of a completed Variant.

The client renders the continuation as an ordinary separate Message. Conversation Generation Settings choose either an ephemeral continuation instruction or an assistant-prefill request. Assistant prefill may append a configured empty, space, newline, or double-newline suffix to the preceding model text sent to the provider, but request shaping never mutates either stored Message.

Continue is available only when selected history ends with a terminal model-authored Message and no Generation is active. The Participant holding model Control when Continue starts authors the new Message, even when another Participant authored the preceding Message. The instruction strategy uses a required editable Continuation instruction; assistant prefill ignores it. Complete, length-limited, and interrupted Variants with visible content may be continued. A reasoning-only Variant may use the instruction strategy but cannot use assistant prefill because version one excludes reasoning from later prompts.
