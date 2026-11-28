# Configuring the app over HTTP

The running server describes its whole HTTP API at `GET /api/openapi.json` (OpenAPI 3.1, generated from the route schemas in `src/shared/contract`). The server listens on `http://127.0.0.1:3000` unless `HOST` or `PORT` say otherwise; in dev, Vite on 5173 proxies `/api` to it.

Settings change through `POST …/commands` routes. Each body is one command picked by its `type` (Conversation commands nest it as `action.type`), and carries the `expectedRevision` of the state it was based on. Prompt Preset block routes (`/api/prompt-presets/:presetId/blocks…`) take no revision, so their last write wins.

1. `GET` the settings and read their `revision`.
2. Send the command with `expectedRevision` set to that revision.
3. On `409` with `outcome: "conflict"`, someone else changed the state first: `GET` again and redo the edit on the new state.

`422` means the body failed validation; the response says why. Open browser tabs pick up every applied change, so the user sees your edits as they land.

Two Connection Settings actions belong to the user:

- `set-credential` and `reset-credential` handle API keys. Ask the user to enter the key in the app instead of passing it through your context.
- `POST /api/connection-settings/test-connection` sends a real request to the provider, which may be billed. Ask first.
