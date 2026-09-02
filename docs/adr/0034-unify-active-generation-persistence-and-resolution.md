# Unify Active Generation persistence and resolution

## Context

Active Generations in SQLite are tracked in `active_generation` with `(conversation_id, id, message_id, variant_id)`. Previously, the persistence layer bifurcated checkpointing and resolution between Tail Generations and Sibling Generations (`checkpointConversationGeneration` vs `checkpointConversationSiblingGeneration`, and `resolveConversationTailGeneration` vs `resolveConversationSiblingGeneration`).

This split was artificial: an active generation row already points authoritatively to its provisional target variant and owning message. The bifurcated commands performed identical database mutations, forcing callers such as the Generation Coordinator to branch and pass distinct callbacks, and leaving `ConversationModule` with redundant surface area.

## Decision

We unify checkpoint persistence and resolution around the canonical `(conversationId, generationId)` aggregate key:

1. One `checkpointConversationGeneration` command handles all checkpoint writes to `(conversationId, generationId)`.
2. One `resolveConversationGeneration` command transitions any provisional target into a durable terminal Variant, records terminal metadata, removes the `active_generation` row, and advances the Conversation Revision.
3. Like `removeConversationGeneration`, resolution inspects the active row's target directly, removing the need for `mode` parameters or separate sibling/tail resolution commands.
4. `generateSiblingVariant` returns `SiblingGenerationResult` directly from its lifecycle resolution, providing symmetric result contracts across Tail, Continuation, and Sibling generation workflows. Multi-generation batching (such as generating 3 sibling variants concurrently) is orchestrated at the coordinator or workflow layer without requiring special persistence branches.

## Alternatives considered

- Retaining distinct sibling and tail resolution commands to enforce semantic intent assertions at the domain boundary was rejected as redundant: `active_generation` already stores its intent and target invariants upon acceptance, and `removeConversationGeneration` already proved that terminal cleanup is naturally unified.
