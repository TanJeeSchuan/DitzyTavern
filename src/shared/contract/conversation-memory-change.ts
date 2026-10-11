import type { BoxId } from "./box";

// @approved
//  Cross-domain contract between Conversation and Memory: the deep
// Conversation module reports what one committed write changed, and Memory
// applies its own derivation to the report. Neither module imports the
// other; this shared declaration is the only shared vocabulary.

/** @approved
 * What one Conversation write changed for Memory's per-Chat sources.
 * Conversation hands this record to the write observer installed by the
 * application layer; Memory syncs from the reported identifiers alone.
 */
export interface ConversationMemoryChange {
	/** The Conversation whose committed write reported the change. */
	readonly conversationId: number;
	/** Variant rows created or whose text or selection changed; Memory re-derives their collections. */
	readonly touchedVariantIds: readonly number[];
	/** Variant rows deleted by this write; Memory abandons their in-flight work. */
	readonly removedVariantIds: readonly number[];
	/** A Box this write stopped running in the Chat: its background work is abandoned, and a removed Box's Chat-scoped settings go with it. */
	readonly stoppedBox?: { readonly id: BoxId; readonly removed: boolean };
}
