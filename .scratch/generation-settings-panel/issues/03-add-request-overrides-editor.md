# 03 — Add Request Overrides editor

**What to build:** Add a Request Overrides section to the consolidated Generation panel editing all three API Format namespaces as JSON objects using json-edit-react. Only the namespace matching the active Connection Profile's format is transmitted with requests; the others stay editable application state.

**Blocked by:** 01 — Consolidate Generation panel and expose Sampling.

**Status:** complete

- [x] All three namespaces (Chat Completions, Responses, Anthropic Messages) are visible and independently editable.
- [x] Copy explains that only the namespace of the Chat's active Connection Profile is sent and other namespaces are kept but never transmitted.
- [x] The editor shows which namespace is currently transmitting based on the active Connection Profile's API Format loaded from Connection Settings.
- [x] Non-object or non-JSON values fail validation client-side without discarding the draft.
- [x] Keys colliding with first-class Sampling fields (temperature, top_p, frequency_penalty, presence_penalty) show a non-blocking notice that the override wins when the request is built.
- [x] Structural and managed output-limit keys rejected by the server merge carry an explanation rather than failing silently.
- [x] Saving runs through the same whole-object Apply as every other section so no separate command exists for overrides alone.
- [x] Unit tests cover collision detection against the closed first-class key set.
- [x] `bun test` and `bun run lint` pass.

**Notes:** Draft helpers extended in [src/client/generation-settings-draft.ts](../../../src/client/generation-settings-draft.ts) with tests colocated; the Request Overrides section was added to [src/client/workspace/GenerationPanel.tsx](../../../src/client/workspace/GenerationPanel.tsx) after Continuation, rendering one JsonEditor per API Format namespace with transmission status resolved from the active Connection Profile. Draft parsing mirrors the server cloneRequestOverrides JSON-value rule (object tag plus serialization check) and reuses the server's exact message, and the closed key families now live in [src/shared/generation-overrides.ts](../../../src/shared/generation-overrides.ts) imported by both the Chat Completions merge ([deepseek.ts](../../../src/server/model-client/deepseek.ts)) and the client notices so they cannot drift. Apply stays the single whole-object update-generation-settings command with no separate overrides command. Verified with 537 passing tests, oxlint, `tsc --noEmit`, and a clean `vite build`.
