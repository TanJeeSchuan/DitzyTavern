# Treat Tavern Cards as an import format

Tavern Card data will enter through an adapter that maps supported fields into the smaller native Actor Profile model. Tavern Card versions, PNG metadata, extension fields, and round-trip compatibility will not dictate internal storage or prompt assembly; unsupported imported fields must be reported explicitly.

Other SillyTavern imports—including chat history, settings, presets, lorebooks, and extension data—are deferred from version one but remain a future requirement. They will be implemented as explicit migration adapters into proven native models rather than by preserving legacy fields in advance.
