# Keep connection secrets outside Conversation state

The API credential is server-owned application configuration, not Conversation data. Version one persists it in a separate app-local secrets file with restrictive filesystem permissions where the operating system supports them. An environment variable may override the stored credential for advanced and automated deployments.

The credential is never copied into SQLite, Conversation or Profile exports, snapshots, SSE events, logs, Prompt Plans, Generation Settings, or Variant settings records. Client APIs expose only whether a credential is configured and accept replacement or removal without returning the current value.

Version one will not implement bespoke reversible encryption. A local process running with the same user authority would also be able to obtain the encryption key, so custom encryption would add complexity without establishing a meaningful security boundary. An operating-system credential vault may replace the file in a future deployment model without changing the Conversation domain.
