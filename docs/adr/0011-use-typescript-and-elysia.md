# Use TypeScript and Elysia for the server

The reimplementation will use TypeScript end-to-end, with Elysia as the HTTP and SSE server framework running natively on Bun. Runtime-validated command, snapshot, and event schemas will be the contract boundary shared with the thin SPA.

The SPA uses Eden Treaty for typed revisioned HTTP commands and errors. Resumable event delivery uses a small native EventSource wrapper, with incoming SSE payloads validated against the shared schemas.
