---
status: accepted
---

# Share imported Conversation creation across import paths

**2026-11-17 amendment.** We removed the developer command `db:import` because an API-based agent interface will replace it. Browser Staged Import is now the only path for importing a Chat.

The browser Staged import and the developer import will create imported Conversations through one `createImportedConversation` workflow. Each importer keeps ownership of source parsing, temporary state, Exact source artifact storage, duplicate handling, and retry behavior, then passes the prepared import data to the workflow. The workflow performs the existing Character Library and Conversation changes as one SQLite operation and returns the created Conversation. It knows nothing about HTTP, Staging handles, previews, or durable import jobs. This is an extraction of existing behavior: it adds no route, schema, artifact subsystem, lifecycle, or generic workflow framework.
