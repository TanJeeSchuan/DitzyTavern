/**
 * One optimistic-revision seam: every server aggregate that guards writes by
 * a revision counter throws the single `StaleRevisionError` through the
 * single `guardRevision`.
 *
 * The aggregate names the wire envelope the error presents as: most 409s
 * carry the expected/actual revisions and the authoritative current state of
 * the aggregate (`presentDomainError` spreads `details`, so the envelope is
 * built here where the class and its aggregate live), and the generation
 * start families model only the prose reason envelope.
 */
import type { ConnectionSettingsPayload } from "../shared/contract/connection-settings";
import type { CharacterSnapshot } from "../shared/contract/character-library";
import type { ConversationSummary } from "../shared/contract/conversation-schema";
import type { Lorebook, LorebookOwnerAttachmentState } from "../shared/contract/lorebook";
import type {
	ConversationMemories,
	ConversationMemoryAllowance,
	MemoryCollectionView,
} from "../shared/contract/memory";
import type { MemorySettingsPayload } from "../shared/contract/memory-settings";
import type { PromptPresetSummary } from "../shared/contract/prompt-preset";
import type { SemanticTriggerSettingsPayload } from "../shared/contract/semantic-trigger-settings";

export type RevisionAggregate =
	| "settings"
	| "preset"
	| "lorebook"
	| "lore-attachment"
	| "character"
	| "conversation"
	| "generation"
	| "memories"
	| "collection";

// @approved
//  The authoritative current reads each aggregate's conflict recovers with,
// all projected through the shared wire contracts the 409 schemas declare.
export type StaleRevisionCurrent =
	| ConnectionSettingsPayload
	| MemorySettingsPayload
	| SemanticTriggerSettingsPayload
	| ConversationMemoryAllowance
	| PromptPresetSummary
	| Lorebook
	| LorebookOwnerAttachmentState
	| CharacterSnapshot
	| ConversationSummary
	| MemoryCollectionView
	| ConversationMemories;

const staleAggregateLabel = {
	settings: "settings",
	preset: "Prompt Preset",
	lorebook: "Lorebook",
	"lore-attachment": "Character",
	character: "Character",
	conversation: "Conversation",
	generation: "Conversation",
	memories: "Memory label",
	collection: "Memory collection",
} satisfies Record<RevisionAggregate, string>;

type StaleRevisionFields = {
	readonly aggregate: RevisionAggregate;
	readonly expectedRevision: number;
	readonly actualRevision: number;
	readonly current: StaleRevisionCurrent | undefined;
	readonly message: string;
};

// @approved
//  The closed wire-envelope union: one member per aggregate, matching the
// 409 schema each route family declares. Throw sites no longer hand-roll
// details and no per-module recovery presenters exist.
export type StaleRevisionDetails =
	| { expectedRevision: number; actualRevision: number; currentSettings: StaleRevisionCurrent }
	| { reason: "stale-revision"; expectedRevision: number; actualRevision: number; currentPreset: StaleRevisionCurrent }
	| { reason: "stale-revision"; expectedRevision: number; actualRevision: number; currentBook: StaleRevisionCurrent }
	| { reason: "stale-revision"; expectedRevision: number; actualRevision: number; currentState: StaleRevisionCurrent }
	| { expectedRevision: number; actualRevision: number; currentCharacter: StaleRevisionCurrent }
	| { expectedRevision: number; actualRevision: number; currentConversation: StaleRevisionCurrent }
	| { reason: string }
	| { memories: StaleRevisionCurrent }
	| { collection: StaleRevisionCurrent };

export const staleRevisionDetails = (fields: StaleRevisionFields): StaleRevisionDetails => {
	const { aggregate, expectedRevision, actualRevision, current, message } = fields;
	switch (aggregate) {
		case "settings":
		case "preset":
		case "lorebook":
		case "lore-attachment":
		case "character":
		case "conversation":
		case "memories":
		case "collection": {
			// SAFETY: these aggregates declare the authoritative current read as a
			// required constructor argument (only the prose "generation" envelope
			// accepts an absent one), so their wire keys always receive a payload.
			const payload = current as StaleRevisionCurrent;
			switch (aggregate) {
				case "settings":
					return { expectedRevision, actualRevision, currentSettings: payload };
				case "preset":
					return { reason: "stale-revision", expectedRevision, actualRevision, currentPreset: payload };
				case "lorebook":
					return { reason: "stale-revision", expectedRevision, actualRevision, currentBook: payload };
				case "lore-attachment":
					return { reason: "stale-revision", expectedRevision, actualRevision, currentState: payload };
				case "character":
					return { expectedRevision, actualRevision, currentCharacter: payload };
				case "conversation":
					return { expectedRevision, actualRevision, currentConversation: payload };
				case "memories":
					return { memories: payload };
				case "collection":
					return { collection: payload };
			}
		}
		case "generation":
			return { reason: message };
	}
};

export class StaleRevisionError extends Error {
	readonly outcome = "conflict" as const;
	readonly details: StaleRevisionDetails;

	// The four state-bearing receivers are the client's recovery payload; the
	// prose-only "generation" envelope takes no state.
	constructor(
		readonly aggregate: RevisionAggregate,
		readonly expectedRevision: number,
		readonly actualRevision: number,
		readonly current?: StaleRevisionCurrent,
	) {
		super(
			`Expected ${staleAggregateLabel[aggregate]} revision ${expectedRevision}, but the current revision is ${actualRevision}.`,
		);
		this.name = "StaleRevisionError";
		this.details = staleRevisionDetails({ aggregate, expectedRevision, actualRevision, current, message: this.message });
	}
}

// @approved
//  The one revision guard: an already-read revisioned row that must still
// carry the expected revision, and a reader for the authoritative current
// state the conflict envelope recovers with (evaluated on the stale path
// only). Modules keep their own existence checks and their own revision
// advances; this seam is only the compare-and-throw.
/**
 * The current-state reader is optional only for aggregates whose envelope
 * carries nothing but the prose reason ("generation"): their throws have no
 * authoritative state to recover with.
 */
export function guardRevision(
	aggregate: RevisionAggregate,
	expectedRevision: number,
	row: { readonly revision: number },
	current: () => StaleRevisionCurrent,
): void {
	if (row.revision === expectedRevision) return;
	throw new StaleRevisionError(aggregate, expectedRevision, row.revision, current());
}
