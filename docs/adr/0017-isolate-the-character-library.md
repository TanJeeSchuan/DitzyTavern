# Isolate the Character Library

Reusable Characters live in a deep Character Library module exposing a small interface for listing Characters, reading one Character's authoritative state, and executing revisioned commands. The module owns Character lifecycle, Definitions, revisions, pinning, permanent deletion, and copying a Participant into a new Character.

A Definition is complete: a normalized nonblank name, a typed Prompt stored exactly as authored, and ordered nonblank openings. Creation accepts one complete Definition in a single atomic command. Rename, whole-Prompt replacement, whole-openings replacement, pinning, and deletion are separate atomic commands that require the expected revision and increment it on success; a stale command fails without changes and returns a typed conflict carrying the authoritative current Character. Normal reads exclude lifecycle tombstones and order pinned Characters first, then alphabetically within each group, using stable identifiers only as an invisible duplicate tie-breaker.

The Conversation module receives copied Participant data and does not depend on Character lifecycle or preserve live links. An Add-from-Character command always creates a new Participant fork; switching to a previously used identity is instead a Cast operation owned by the Conversation module.
