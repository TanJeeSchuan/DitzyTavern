# Apply configuration edits atomically

Configuration panels edit client-local drafts rather than mutating authoritative state per keystroke. Explicit semantic Apply actions send revisioned commands that validate and atomically replace a Character or Participant name, whole Prompt, or whole Openings list. Generation Settings and Connection Settings retain their own whole-object Apply actions.

Generations use only the last successfully applied configuration. A sibling Swipe started while a panel is dirty therefore cannot capture a half-edited Prompt, incomplete endpoint, or temporarily invalid JSON object; unsaved edits remain client-local and do not create authoritative revisions.

If another client changes the same Conversation before Apply, the expected-Revision check rejects the stale command. The client preserves the complete local draft and refreshed authoritative state for manual comparison or retry; version one performs no field-level automatic merge. Application-global Connection Settings use the same atomic replacement behavior with their own configuration revision.
