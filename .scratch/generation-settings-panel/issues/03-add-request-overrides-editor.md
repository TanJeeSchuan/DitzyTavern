# 03 — Add Request Overrides editor

**What to build:** Add a Request Overrides section to the consolidated Generation panel editing all three API Format namespaces as JSON objects using json-edit-react. Only the namespace matching the active Connection Profile's format is transmitted with requests; the others stay editable application state.

**Blocked by:** 01 — Consolidate Generation panel and expose Sampling.

**Status:** pending

- [ ] All three namespaces (Chat Completions, Responses, Anthropic Messages) are visible and independently editable.
- [ ] Copy explains that only the namespace of the Chat's active Connection Profile is sent and other namespaces are kept but never transmitted.
- [ ] The editor shows which namespace is currently transmitting based on the active Connection Profile's API Format loaded from Connection Settings.
- [ ] Non-object or non-JSON values fail validation client-side without discarding the draft.
- [ ] Keys colliding with first-class Sampling fields (temperature, top_p, frequency_penalty, presence_penalty) show a non-blocking notice that the override wins when the request is built.
- [ ] Structural and managed output-limit keys rejected by the server merge carry an explanation rather than failing silently.
- [ ] Saving runs through the same whole-object Apply as every other section so no separate command exists for overrides alone.
- [ ] Unit tests cover collision detection against the closed first-class key set.
- [ ] `bun test` and `bun run lint` pass.
