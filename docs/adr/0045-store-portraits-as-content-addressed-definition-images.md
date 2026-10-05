# Store Portraits as content-addressed Definition images

A Portrait is part of the Definition, not a live property of a Character. Seeding a Participant copies it with the rest of the Definition, Save as Character carries it back, and changing a Character's artwork never changes existing Chats. Ad-hoc Participants can have one. A Participant Tombstone loses its Portrait together with its Definition, and its Messages fall back to the stamped name's initial. Author Stamps do not capture Portraits; Messages show their Participant's current one.

Portrait bytes live in SQLite in the image table keyed by SHA-256 that ADR-0046 shares with prompt Images, and a Definition references an image by hash with a focal point. Copying a Definition copies the hash, so artwork used across many Chats is stored once. Images are uploaded through one endpoint and start orphaned. Definitions carry the returned hash. An Image becomes orphaned when its last reference goes; startup deletes Images orphaned for more than 24 hours. A new reference clears the orphan timestamp. Images are immutable and served by hash with permanent caching.

This differs from Exact Source Artifacts, which keep exact import bytes on disk through the artifact module. That module is Conversation-owned and treats missing files as harmless provenance loss; Portraits belong to library Characters too and are needed to render identity, so they share the database's transactions and backup instead.

Portraits use the same ingest as every Image in [ADR-0046](0046-admit-images-natively.md). The server accepts PNG, JPEG, WebP, and GIF by magic bytes, strips metadata losslessly (including EXIF and embedded Tavern Card data), and never resizes, transcodes, or decodes, so animation survives. Display frames the full-resolution artwork with a focal point applied as the object position, instead of a stored crop rectangle or a downscaled copy.

Tavern Card import, URL sources, and character-derived ambient color are outside this decision.
