import type { BoxId } from "./box";

/** @approved
 * What one committed Conversation write changed. Conversation hands it to the
 * write observer installed by the application layer, which queues the digests
 * of the Boxes running in the Chat.
 */
export interface ConversationWriteChange {
	/** The Conversation whose committed write reported the change. */
	readonly conversationId: number;
	/** Variant rows created or whose text or selection changed; enabled Boxes digest them again when their text changed. */
	readonly touchedVariantIds: readonly number[];
	/** Variant rows deleted by this write; their queued digests are dropped. */
	readonly removedVariantIds: readonly number[];
	/** A Box this write stopped running in the Chat: its background work is abandoned. */
	readonly stoppedBox?: BoxId;
}
