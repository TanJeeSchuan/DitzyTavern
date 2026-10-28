# Lay out system blocks per Connection Profile

Many chat targets accept system instructions only at the start of a request. The OpenCode gateway rejects a later one for Claude with HTTP 400 and returns 503 for Gemini, and the native Anthropic and Gemini APIs and many open-model chat templates cannot express one at all. The Default preset sends the scenario as a system message after the assistant-role model identity, every Box and the post-history instruction follow history as system messages, and the instruction Continuation appended a trailing system message, so the Default preset failed on those targets ([#129](https://github.com/TanJeeSchuan/DitzyTavern/issues/129)).

Each Connection Profile chooses a System Placement, Strict by default. Under Strict the Prompt Compiler moves the system blocks before the first history slot to the front, in their order, and sends any system block that follows another message as a human message where it stands, marked `demoted` in the Prompt Plan. A recipe without history therefore collapses every system block into the leading run. The instruction Continuation is demoted the same way. None keeps the recipe's order and roles exactly. The layout is part of the compiled Prompt Plan, so inspection, budgeting and the Model Client see the same request, and the Model Client only translates roles. A system message's Images follow the end of its run of system messages, so a leading run stays leading.

On a target that only accepts leading system instructions, a later instruction can have system authority only by moving and losing its recency. Blocks before history are static Definition context, so moving them costs nothing and keeps the provider's cacheable prefix stable. Blocks after history are there for recency and change every turn, so they keep their place.

## Considered Options

- Moving every system block to the front: rejected because per-turn Box, Author Note and Lore content ahead of history defeats automatic prefix caching on every turn, and the Continuation instruction would precede the text it refers to.
- A per-model placement fact in the model record of #94 and #111: rejected because the same model accepts late system messages on one connection and not another, and Strict works on every target.
- Validating presets against target constraints and failing before the request: rejected because the Default preset would fail on every leading-only target.
- Authoring semantic block kinds and compiling a layout per target, or a separate exact-presentation mode: rejected as more machinery than one rule that already works everywhere.
- Merging adjacent same-role messages: deferred until a target rejects consecutive user messages.
