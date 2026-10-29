# Chat Forking

## Problem Statement

A writer who wants to try a different direction from an earlier point in a Chat has two options, and both lose something. Swiping an old Message and confirming the change keeps every later Message, though they were written after the Variant being replaced, so the story stops making sense there. Deleting the later Messages loses the original story.

## Solution

A Fork copies a Chat's history through one Message into a new, independent Chat. It starts from a Message's actions or from Preview mode, where it takes the previewed Variant. A Rewind is a Fork that ends just before a Human-authored Message and puts that Message's text and Moves in the new Chat's composer to rewrite. The Fork carries the source's Cast, settings and Box data, so its story state matches the source at the fork point. It records a removable Fork link to its source.

See [ADR-0052](../adr/0052-fork-chats-as-independent-copies.md).

## User Stories

### Starting a Fork

1. As a writer, I want "Fork from here" on any Message, so that I can start a new Chat that ends at that Message.
2. As a writer previewing an older Variant, I want "Fork with this Variant" beside Confirm Change and Cancel, so that I can follow that Variant without keeping Messages written against another one.
3. As a writer, I want a dialog to name the Fork before it is created, prefilled with "*Name* (fork)", so that I can tell my Chats apart.
4. As a writer, I want an unchecked "Trim Variants? (Destructive, will remove all other unselected variant data for the fork)" option, so that I can make a lean Fork when I don't need the alternatives.
5. As a writer, I want the new Chat opened once it is created, so that I can carry on writing.
6. As a writer, I want forking refused while a Generation is running, with a reason, so that the Fork never holds a half-written Variant.

### What the Fork holds

7. As a writer, I want the Fork to keep every Variant of the copied Messages by default, so that I can still swipe through earlier alternatives.
8. As a writer, I want the Fork to keep the Cast, Control, Definitions, Generation Settings, Prompt Preset selection, lorebooks, Author Note and background, so that it writes the way the source did.
9. As a writer, I want Macro Variables, Memories, the World Clock and a running Race to stand in the Fork where they stood at the fork point, so that the story carries on consistently.
10. As a writer, I want edits in the Fork never to change the source, and the other way round, so that each Chat is safe to change.
11. As a writer, I want forking to fail with a reason naming the Box when a Box's data can't be copied correctly, so that I never get a Fork with broken links.
12. As a writer, I want the result to tell me which Boxes weren't copied because they aren't installed, so that I know what's missing.
13. As a writer forking an imported Chat, I want the Fork to be a plain native Chat, so that it doesn't claim to be the import.

### Rewind

18. As a writer, I want "Rewind" on a Human-authored Message, so that I can rewrite what I said there in a new Chat without losing the original.
19. As a writer rewinding, I want that Message's text, Images and Moves waiting in the new Chat's composer, so that I only change what I meant to.

### Fork link

14. As a writer, I want the Fork's header to show "Forked from *Name*", opening the source at the fork point, so that I can go back to where it split.
15. As a writer, I want to remove that link, so that a Fork can stand on its own.
16. As a writer, I want to fork a Fork, and so on, each linking to its own source, so that I can explore as deep as I like.
17. As a writer, I want the link to survive deleting the fork point, pointing at the Chat, and to disappear when the source Chat is deleted, so that it never points at nothing.

## Implementation Decisions

1. One `fork-conversation` command on the source Chat: `{ at, trimVariants, name, expectedRevision }`, where `at` is `{ through: messageId, variantId? }` for a Fork or `{ rewind: messageId }` for a Rewind. `variantId` must belong to the `through` Message and is selected there in the Fork. A Rewind's Message must be Human-authored; the Fork copies the Messages before it, possibly none. One transaction; it returns the new Conversation, the ids of Boxes left out, and for a Rewind the Message's selected text and its Moves, rewritten through the id map like any other Box value.
2. Fork link: `conversation.forked_from_conversation_id` and `forked_from_message_id`, the Message forked at (the `through` or `rewind` Message), both `ON DELETE SET NULL`, with a check that the message is null whenever the Chat is. A revisioned `unlink-fork` command clears both.
3. Box Row References follow ADR-0052. The box-sdk gains `MessageId`, `VariantId`, `ParticipantId` and `ParticipantKey`; the descriptor declares a schema for each Chat and Participant value key. Memory and Race adopt them. The SDK version goes up and there is no compatibility path.
4. Failure: an uncopied Row Reference in setup, a Move, a record or a stored value, or a Box value with no declared schema, fails the command with a typed error naming the Box and the path. Traces keep uncopied ids unchanged.
5. Boxes that aren't loaded: their Chat data, Moves, record slots, Participant data and trace entries aren't copied.
6. State derived from selected Variants (Macro State, Box folds, Memory Collections) stands as of the fork point. Chat-scoped values (Box setup and Chat values, the Author Note, Generation Settings) are copied as they are now.
7. Not copied: Import provenance, Canonical Source Archive, Exact Source Artifact, generation captures, generation replays.
8. The client puts a Rewind's text and Moves in the new Chat's composer. The server keeps no draft.

## Out of Scope

- Merging Forks, or listing a Chat's Forks.
- Collapsing references to trimmed Variants onto the selected Variant (ADR-0052).
