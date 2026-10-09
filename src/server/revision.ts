/**
 * @approved
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

// @approved
//  The aggregate → payload map: each state-bearing aggregate declares exactly
//  the authoritative current read its conflict recovers with, all projected
//  through the shared wire contracts the 409 schemas declare. Only the prose
//  "generation" envelope carries no state (`undefined`).
export type CurrentByAggregate = {
	settings: ConnectionSettingsPayload | MemorySettingsPayload | SemanticTriggerSettingsPayload | ConversationMemoryAllowance;
	preset: PromptPresetSummary;
	lorebook: Lorebook;
	"lore-attachment": LorebookOwnerAttachmentState;
	character: CharacterSnapshot;
	conversation: ConversationSummary;
	generation: undefined;
	memories: ConversationMemories;
	collection: MemoryCollectionView;
};

export type RevisionAggregate = keyof CurrentByAggregate;

// @approved
//  The discriminated constructor/guard argument tuples derived from the map:
//  every state-bearing aggregate must pass its mapped payload, and only
//  "generation" takes none.
type StaleRevisionArgs = {
	[K in RevisionAggregate]: CurrentByAggregate[K] extends undefined
		? [aggregate: K, expectedRevision: number, actualRevision: number]
		: [aggregate: K, expectedRevision: number, actualRevision: number, current: CurrentByAggregate[K]];
}[RevisionAggregate];

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

// @approved
//  The closed wire-envelope union: one member per aggregate, matching the
//  409 schema each route family declares. Throw sites no longer hand-roll
//  details and no per-module recovery presenters exist.
type StaleRevisionDetails =
	| { expectedRevision: number; actualRevision: number; currentSettings: CurrentByAggregate["settings"] }
	| { reason: "stale-revision"; expectedRevision: number; actualRevision: number; currentPreset: CurrentByAggregate["preset"] }
	| { reason: "stale-revision"; expectedRevision: number; actualRevision: number; currentBook: CurrentByAggregate["lorebook"] }
	| { reason: "stale-revision"; expectedRevision: number; actualRevision: number; currentState: CurrentByAggregate["lore-attachment"] }
	| { expectedRevision: number; actualRevision: number; currentCharacter: CurrentByAggregate["character"] }
	| { expectedRevision: number; actualRevision: number; currentConversation: CurrentByAggregate["conversation"] }
	| { reason: string }
	| { memories: CurrentByAggregate["memories"] }
	| { collection: CurrentByAggregate["collection"] };

const staleRevisionDetails = (args: StaleRevisionArgs, message: string): StaleRevisionDetails => {
	const [, expectedRevision, actualRevision] = args;
	switch (args[0]) {
		case "settings":
			return { expectedRevision, actualRevision, currentSettings: args[3] };
		case "preset":
			return { reason: "stale-revision", expectedRevision, actualRevision, currentPreset: args[3] };
		case "lorebook":
			return { reason: "stale-revision", expectedRevision, actualRevision, currentBook: args[3] };
		case "lore-attachment":
			return { reason: "stale-revision", expectedRevision, actualRevision, currentState: args[3] };
		case "character":
			return { expectedRevision, actualRevision, currentCharacter: args[3] };
		case "conversation":
			return { expectedRevision, actualRevision, currentConversation: args[3] };
		case "memories":
			return { memories: args[3] };
		case "collection":
			return { collection: args[3] };
		case "generation":
			return { reason: message };
	}
};

export class StaleRevisionError extends Error {
	readonly outcome = "conflict" as const;
	readonly aggregate: RevisionAggregate;
	readonly expectedRevision: number;
	readonly actualRevision: number;
	readonly current: CurrentByAggregate[RevisionAggregate] | undefined;
	readonly details: StaleRevisionDetails;

	constructor(...args: StaleRevisionArgs) {
		const [aggregate, expectedRevision, actualRevision] = args;
		super(
			`Expected ${staleAggregateLabel[aggregate]} revision ${expectedRevision}, but the current revision is ${actualRevision}.`,
		);
		this.name = "StaleRevisionError";
		this.aggregate = aggregate;
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
		this.current = args.length === 4 ? args[3] : undefined;
		this.details = staleRevisionDetails(args, this.message);
	}
}

// @approved
//  One revision guard: an already-read revisioned row that must still carry
//  the expected revision, and a reader for the authoritative current state
//  the conflict envelope recovers with (evaluated on the stale path only).
//  Modules keep their own existence checks and their own revision advances;
//  this seam is only the compare-and-throw.
type GuardRevisionArgs = {
	[K in RevisionAggregate]: CurrentByAggregate[K] extends undefined
		? [aggregate: K, expectedRevision: number, row: { readonly revision: number }]
		: [aggregate: K, expectedRevision: number, row: { readonly revision: number }, current: () => CurrentByAggregate[K]];
}[RevisionAggregate];

export function guardRevision(...args: GuardRevisionArgs): void {
	const [aggregate, expectedRevision, row] = args;
	if (row.revision === expectedRevision) return;
	// @approved
	//  SAFETY: `GuardRevisionArgs` is a union of per-aggregate tuples, so the
	//  caller's aggregate and reader are already paired; TypeScript cannot carry
	//  that correlation through the rebuilt constructor tuple.
	throw new StaleRevisionError(
		...((args.length === 3 ? [aggregate, expectedRevision, row.revision] : [aggregate, expectedRevision, row.revision, args[3]()]) as StaleRevisionArgs),
	);
}
