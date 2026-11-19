/**
 * @approved
 * One optimistic-revision seam: every server aggregate that guards writes by
 * a revision counter throws the single `StaleRevisionError` through the
 * single `guardRevision`.
 *
 * Stale writes carry both revisions and the authoritative current state.
 * Generation starts use the prose reason envelope.
 */
import type { ConnectionSettingsPayload } from "../shared/contract/connection-settings";
import type { CharacterSnapshot } from "../shared/contract/character-library";
import type { ConversationSummary } from "../shared/contract/conversation-schema";
import type { Lorebook, LorebookOwnerAttachmentState } from "../shared/contract/lorebook";
import type { PromptPresetSummary } from "../shared/contract/prompt-preset";
import type { SemanticTriggerSettingsPayload } from "../shared/contract/semantic-trigger-settings";
import type { BoxDecisionSettings, BoxDelegateSettings } from "../shared/contract/box";

// @approved
//  The aggregate → payload map: each state-bearing aggregate declares exactly
//  the authoritative current read its conflict recovers with, all projected
//  through the shared wire contracts the 409 schemas declare. Only the prose
//  "generation" envelope carries no state (`undefined`).
export type CurrentByAggregate = {
	settings: ConnectionSettingsPayload | SemanticTriggerSettingsPayload | BoxDecisionSettings | BoxDelegateSettings;
	preset: PromptPresetSummary;
	lorebook: Lorebook;
	"lore-attachment": LorebookOwnerAttachmentState;
	character: CharacterSnapshot;
	conversation: ConversationSummary;
	generation: undefined;
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
} satisfies Record<RevisionAggregate, string>;

export class StaleRevisionError extends Error {
	readonly outcome = "conflict" as const;
	readonly aggregate: RevisionAggregate;
	readonly expectedRevision: number;
	readonly actualRevision: number;
	readonly current: CurrentByAggregate[RevisionAggregate] | undefined;
	readonly details;

	constructor(...args: StaleRevisionArgs) {
		const [aggregate, expectedRevision, actualRevision, current] = args;
		super(
			`Expected ${staleAggregateLabel[aggregate]} revision ${expectedRevision}, but the current revision is ${actualRevision}.`,
		);
		this.name = "StaleRevisionError";
		this.aggregate = aggregate;
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
		this.current = current;
		this.details = current === undefined
			? { reason: this.message }
			: { reason: "stale-revision" as const, expectedRevision, actualRevision, current };
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
