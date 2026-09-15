# Introduce shared native Lorebooks

Lorebooks will have a native editor and an explicit SillyTavern import adapter for a selected subset of source behavior. Unsupported behavior must be reported during import. This takes up the lorebook feature deferred by ADR-0001, ADR-0006 and ADR-0007 without promising complete SillyTavern behavior.

Lorebooks are shared library objects. Saved edits apply to subsequent Generations in every Chat using that book, while an explicit duplicate creates an independent version. Unlike Character Definitions copied into Participants, lore content stays shared so correcting a fact does not require editing separate copies in every Chat. Chats that need different canon must use separate books.

Books can be attached to Chats and Characters/Participants, with deduplication when attachments overlap. Global activation is deferred. The initial feature covers explicitly authored lore; model-written memory remains a separate future feature.

Creating a Participant copies the Character's attachment list. Later Character attachment edits do not change that Participant's list, while edits to the referenced books remain shared. Repeated references to the same book contribute it once; an explicitly duplicated book has its own identity and remains independent.

Scope belongs to each attachment, keeping the Lorebook itself independent of where it is used. Controlled Participant scope requires the attached Participant to occupy either control seat. Cast scope makes the book eligible while that Participant is anywhere in the Cast. Chat scope attaches the book directly to the Chat, independently of Participants. One shared book can therefore have different scopes in different uses without duplicating its content.

Support standalone SillyTavern lorebook JSON import and native Lorebook JSON import/export. Native book exports exclude attachments and their scopes. Extracting embedded books from PNG Character Cards is deferred. Imports retain supported behavior with warnings for unsupported portions, rather than disabling entries solely because they use unsupported behavior. This prioritizes immediate use of imported content over reproducing its original activation conditions.

Edit Lorebooks in a popup like Prompt Presets, an explicit exception to DESIGN.md's primary-panel preference. Deleting a shared book shows its affected attachments first; a confirmed deletion removes the book and those attachments. Removing an attachment alone leaves the shared book intact. Duplication and native reimport create independent identities rather than merging with the original.

Each entry has its own Save boundary; entry ordering and enable/disable toggles persist immediately. Book name and description have a separate Save action. Closing or switching with unsaved text offers Save, Discard and Keep editing. A new entry starts enabled and conditional with empty triggers and priority zero, so it does not activate until configured.
