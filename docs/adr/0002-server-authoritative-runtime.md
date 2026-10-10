# Put application and generation authority on the server

The server will own conversation state, prompt assembly, generation lifecycles, persistence, and coordination across simultaneously connected clients. Clients issue revisioned HTTP commands and render state published through resumable SSE instead of reproducing SillyTavern's frontend-heavy processing model.

The browser is a thin reactive SPA whose local state is limited to ephemeral presentation concerns. Refreshing a client reconstructs every authoritative Conversation, Revision, Variant, and Generation view from the server.

The client may show a Requested selection or Requested Send before the server acknowledges it, so slow acceptance never freezes the writer. Conversation commands from one client run one at a time per Conversation; a failed command drops the ones queued behind it and the view returns to authoritative state. Requested state is never sent to the server as anything other than the command that created it.

When multiple clients open the same Conversation, they are synchronized views of one live server-owned state, including any generation in progress and its final result. Conversation and generation state must survive individual client refreshes and disconnects.

Each Conversation permits at most one active target Message at a time. Multiple Generations may run concurrently only to create sibling Variants for that same latest Message from the same prompt snapshot; the server rejects commands that would advance or otherwise mutate Conversation history until every sibling Generation has completed or been stopped.

Generated text is not discarded when a Generation is interrupted. If an interrupted Generation has produced text, the server persists that partial text into the Conversation.

This guarantee applies when the running server observes the interruption, such as cancellation or provider failure. The system will not checkpoint live token output merely to recover partial text after an abrupt server-process failure.

The persisted partial Message is marked as interrupted, but that status is informational: it remains part of prompt history and does not prevent the Conversation from continuing normally.

Every command that mutates a Conversation must include its expected Revision. The server applies the command atomically only when that Revision is current; otherwise it rejects the stale command so the client can synchronize before retrying. Transient streamed text does not advance the Revision, while durable Message and Generation lifecycle changes do.

The ordinary Send command persists a Message for the human-controlled Participant and immediately starts one Generation; failure to generate does not roll back that Message. A separate Generate command starts a model-controlled Participant Message without first adding a human-controlled Message.
