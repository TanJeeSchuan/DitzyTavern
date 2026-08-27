# 01 — Create complete Conversations with Variant timestamps

**What to build:** Add one generic Conversation-owned creation capability that atomically accepts a complete native Conversation aggregate, enforces the established Message and Variant invariants, starts the Conversation at revision zero, and returns its snapshot. Add native Variant timestamps and preserve existing data during migration. The capability must remain format-neutral so later migration adapters can use it without leaking legacy vocabulary into the Conversation interface.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] A Variant has a required timestamp in persisted state and Conversation snapshots.
- [x] Existing Variants receive their owning Message timestamp during migration.
- [x] Generic creation atomically persists the Chat, Messages, ordered Variants, exact selection, Character memberships, and scoped data supplied by a valid native aggregate.
- [x] Generic creation rejects a Message with no Variants or anything other than exactly one selected Variant without leaving partial data.
- [x] A newly created Conversation has revision `0` and can be read through the public Conversation snapshot seam.
- [x] The creation interface and its tests contain no SillyTavern-specific types or terminology.
- [x] Focused in-memory tests verify public behavior without duplicating implementation details.

## Comments

- Completed in commit `6b40843` on `master`. Migration `0003_strange_the_executioner.sql` backfills existing Variants from their owning Message timestamp; `ConversationModule.create` persists complete native aggregates at revision 0 with full atomic rollback. 11 tests pass, typecheck and lint clean. Reviewed by Standards + Spec sub-agents; findings addressed.
