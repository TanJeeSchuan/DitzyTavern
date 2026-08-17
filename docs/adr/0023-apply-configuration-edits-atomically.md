# Apply configuration edits atomically

Configuration panels edit client-local drafts rather than mutating authoritative state per keystroke. An explicit Apply action sends one revisioned command that validates and atomically replaces the relevant Participant Prompt, Generation Settings, or Connection Settings object.

Generations use only the last successfully applied configuration. A sibling Swipe started while a panel is dirty therefore cannot capture a half-edited prompt, incomplete endpoint, or temporarily invalid JSON object. Closing a dirty panel asks the user whether to discard its draft.

If another client changes the same Conversation before Apply, the expected-Revision check rejects the stale command. The client preserves the complete local draft and refreshed authoritative state for manual comparison or retry; version one performs no field-level automatic merge. Application-global Connection Settings use the same atomic replacement behavior with their own configuration revision.
