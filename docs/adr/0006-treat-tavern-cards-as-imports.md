# Treat Tavern Cards as an import format

Tavern Card data will enter through an adapter that maps supported fields into the native Character model. Tavern Card versions, PNG metadata, extension fields, and round-trip compatibility will not dictate internal storage or prompt assembly; unsupported imported fields must be reported explicitly.

Other SillyTavern imports—including chat history, settings, presets, lorebooks, and extension data—were deferred from version one as future explicit adapters into proven native models rather than reasons to preserve legacy fields in advance. Chat-history import is now implemented under ADR 0026; settings, presets, lorebooks, and extension-data import remain deferred.
