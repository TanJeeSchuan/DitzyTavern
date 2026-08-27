# 02 — Preserve the exact original import artifact

**What to build:** Extend the existing developer-facing SillyTavern import so that every successful import preserves an independent exact-byte copy of the selected source in DitzyTavern-managed storage, alongside the canonical parsed archive. A maintainer must be able to verify and retrieve the original bytes without making the artifact part of normal Conversation snapshots or a prerequisite for using the imported Chat.

**Blocked by:** 01 — Character System dependency gate.

**Status:** resolved

- [x] A generic Conversation artifact record stores Chat ownership, namespace, key, managed relative path, original leaf filename, media type, byte length, and SHA-256.
- [x] The artifact identity is unique within its owning Conversation by namespace and key.
- [x] Exact bytes are copied from the validated source into a unique managed relative path before the database creation operation begins.
- [x] Failure to write the managed artifact aborts before creating any Chat, Participant, Profile, Message, Variant, Roster, Author Stamp, or artifact metadata row.
- [x] The artifact metadata row is committed with the rest of the Conversation's database state through the public Conversation creation seam.
- [x] The raw-byte SHA-256 remains authoritative and preserves differences in BOM, line endings, whitespace, escape spelling, blank lines, and trailing newline.
- [x] The existing canonical parsed archive and compact import report remain available separately from the exact artifact.
- [x] Public Conversation artifact operations can inspect metadata and stream the exact stored bytes without eagerly placing artifact content in ordinary Conversation snapshots.
- [x] Each import stores an independent physical copy even when another Chat has the same SHA-256; no content-addressing, deduplication, reference counting, or shared-file lifecycle is introduced.
- [x] Committed artifacts are never automatically deleted, including when their Chat is deleted; unused files left by later database failure are accepted and no cleanup or recovery subsystem is added.
- [x] A missing or corrupt artifact is reported as cleaned up or unavailable while the native Chat, canonical archive, and normal Conversation commands remain usable.
- [x] Download uses the stored original leaf filename while sanitizing response metadata without changing the bytes.
- [x] Focused tests exercise exact-byte round trips, canonical-versus-exact preservation, initial storage failure, nonfatal disappearance, and the intentional absence of automatic cleanup through public seams.

## Comments

- This ticket deliberately prefactors exact-source preservation through the already working developer import before the browser workflow depends on it.
