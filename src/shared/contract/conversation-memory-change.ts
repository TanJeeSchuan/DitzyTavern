// @approved
//  Cross-domain contract between Conversation and Memory: the deep
// Conversation module reports what one committed write changed, and Memory
// applies its own derivation to the report. Neither module imports the
// other; this shared declaration is the only shared vocabulary.

/**
 * ==[HUMAN APPROVED]== What one Conversation write changed for Memory's per-Chat sources.
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
	/** True when the write replaced the selected Prompt Preset and Memory's whole per-Chat context changed. */
	readonly promptPresetChanged: boolean;
}
