---
status: proposed
---

# Share imported Conversation creation across import paths

The browser Staged import and the developer import will create imported Conversations through one `createImportedConversation` workflow. Each importer keeps ownership of source parsing, temporary state, Exact source artifact storage, duplicate handling, and retry behavior, then passes a Conversation-ready import plan and one `StoredExactSourceArtifact` to the workflow. The plan explicitly identifies each Participant as a fork of a current Character, a new Character, or Chat-only; the workflow resolves current Character Definitions, assigns deterministic Control, adds the internal artifact identity, and performs the Character Library and Conversation changes as one SQLite operation. It returns only the created Conversation. The workflow knows nothing about HTTP, Staging handles, previews, or durable import jobs. This keeps the Staged import as the only browser-facing import seam while preventing the two import paths from developing different persistence behavior.

The current implementation does not yet realize this decision: the two paths share source decoding and generic Conversation creation, but each still orchestrates its own persistence. This ADR remains proposed until both paths call the shared workflow.
