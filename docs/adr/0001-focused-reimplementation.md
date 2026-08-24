# Build a clean-slate, focused reimplementation

This project will be a clean-slate, focused reimplementation inspired by selected SillyTavern capabilities, not a refactor, drop-in replacement, or compatibility fork. The upstream checkout is behavioral reference material only: its architecture, module boundaries, data flow, APIs, and frontend/server split carry no presumption of survival, and the new product will re-derive its own shape around the chosen subset.

The first product boundary is a local, single-user, text-first application for persistent roleplay with a Conversation-local Cast and one human-controlled and one model-controlled Participant at a time, initially through one OpenAI-style streaming protocol. Additional features must tighten this main flow rather than introduce a separate product loop.

A durable native Conversation is created atomically with at least two distinct Cast Participants and both Control seats assigned. Version one has no persisted native setup draft or partially configured native Conversation; every other configuration may be changed after creation while preserving that invariant.

Preservation-oriented imports are the narrow exception to the two-seat invariant: a SillyTavern import that resolves zero or one Participant commits atomically as an incomplete Conversation so custody of the source history is never sacrificed to playability. Such a Chat stays readable, editable, exportable, configurable, and deletable, while Compose, Generate, and Swipe are withheld with one typed not-playable reason until a second distinct Participant fills the empty seat; completion derives playability automatically from native state and leaves no imported-only mode behind.

A quality-of-life feature may shorten, clarify, or recover an existing step in the active-pair roleplay flow. Additional Cast Participants and free seat reassignment are part of that flow, but simultaneous multi-model turns, a context engine, another provider family, an automation system, and media pipelines remain outside it.

Version one excludes World Info and lorebook scanning. Its only prompt-context sources are the two actively controlled Participants' applicable prompt channels, Example Dialogue, and selected Conversation history; lore integration is deferred to the future named-block prompt system.

Version one also exposes no user-installable extension or plugin runtime. Future extensibility will be designed from demonstrated use cases rather than preserving SillyTavern extension or plugin compatibility.

Version one is text-only. It excludes file attachments, multimodal Messages, image generation, speech input/output, and model tool calls, each of which would require a separate storage, provider, rendering, or security pipeline.

Version one also excludes slash commands, regex transforms, auto-continue scripts, and other general prompt automation or interception layers. Prompt text recognizes only the owner-relative `{{self}}` and `{{other}}` macros defined by ADR 0007; broader macro compatibility remains excluded. The supported interaction language is otherwise limited to explicit core Conversation commands.
