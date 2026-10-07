import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import {
	activeGenerationTable,
	generationReplayTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
} from "../../database/schema";
import {
	InvalidConversationCommandError,
} from "../errors";
import { requireConversation, type ConversationDatabase } from "../internal";
import { advanceConversationRevision, runConversationTransaction } from "./transaction";
import type {
	ConversationDataEntry,
	ConversationSummary,
	CheckpointGenerationInput,
	RemoveGenerationInput,
	StopGenerationsInput,
	StoppedGenerations,
	StopGenerationInput,
	ResolveGenerationInput,
} from "../types";
import { GENERATION_REPLAY_RETENTION_MS } from "../generation-retention";
import {
	generationProvenanceCodec,
	generationJsonObject,
	parseGenerationJson,
	readGenerationTerminalMetadata,
} from "../../../shared/generation-provenance";
import { macroWritesToData, parseMacroWrites } from "../../prompt-macros";
import {
	LORE_ACTIVATION_KEY,
	LORE_ACTIVATION_NAMESPACE,
	parseLoreActivationRecord,
} from "../../../shared/contract/lore-activation";
import {
	MEMORY_ACTIVATION_KEY,
	MEMORY_ACTIVATION_NAMESPACE,
	parseMemoryActivationRecord,
} from "../../../shared/contract/memory-recall";

// ==[HUMAN APPROVED]== Terminal lifecycle of the server-owned Generations: resolve, remove,
// checkpoint, and stop. Acceptance seams (tail/continuation/sibling) live in
// accept-generation.ts; both halves share the transaction seam and the
// terminal persistence helpers below.

const readActiveGeneration = (
	db: ConversationDatabase,
	conversationId: number,
	generationId: number,
) => db
	.select()
	.from(activeGenerationTable)
	.where(
		and(
			eq(activeGenerationTable.id, generationId),
			eq(activeGenerationTable.conversation_id, conversationId),
		),
	)
	.get();

export const isSiblingGenerationRow = (row: { generation_intent_json: string }): boolean => {
	let parsed: ReturnType<typeof generationJsonObject>;
	try {
		parsed = generationJsonObject(JSON.parse(row.generation_intent_json));
	} catch {
		throw new InvalidConversationCommandError(
			"The Active Generation has invalid persisted Generation intent.",
		);
	}
	if (
		parsed === null ||
		(parsed.type !== "tail" &&
			parsed.type !== "continuation" &&
			parsed.type !== "sibling")
	) {
		throw new InvalidConversationCommandError(
			"The Active Generation has invalid persisted Generation intent.",
		);
	}
	return parsed.type === "sibling";
};

type ActiveGenerationRow = NonNullable<ReturnType<typeof readActiveGeneration>>;

type CheckpointVariantValues = { content: string; timestamp?: string };

const terminalStatusFrom = (
	data: readonly ConversationDataEntry[],
): "complete" | "length-limited" | "interrupted" => {
	const value = data.find(
		(entry) => entry.namespace === "generation" && entry.key === "outcome",
	)?.value;
	return value === "length-limited" || value === "interrupted" ? value : "complete";
};

// ==[HUMAN APPROVED]== The Active Generation columns the bounded replay window carries over
// verbatim. The exclusions are the active-only bookkeeping the durable
// Variant or the running attempt owns (provenance, human Message, prior
// Variant) and the two checkpoint columns the terminal outcome supplies
// below. Because every other column is named, adding one to
// `active_generation` fails typecheck here until this projection states
// whether the replay row keeps it; spreading the row instead suppressed the
// excess-property check and let both directions of drift pass silently.
type ReplayCarriedColumn = Exclude<
	keyof ActiveGenerationRow,
	| "human_message_id"
	| "prior_variant_id"
	| "provenance_namespace"
	| "provenance_key"
	| "provenance_value"
	| "macro_preset_id"
	| "macro_writes_json"
	| "checkpoint_content"
	| "checkpoint_reasoning"
>;

const replayCarriedColumns = (
	active: ActiveGenerationRow,
): Pick<ActiveGenerationRow, ReplayCarriedColumn> => ({
	id: active.id,
	conversation_id: active.conversation_id,
	message_id: active.message_id,
	variant_id: active.variant_id,
	human_participant_id: active.human_participant_id,
	model_participant_id: active.model_participant_id,
	captured_human_name: active.captured_human_name,
	captured_model_name: active.captured_model_name,
	started_at: active.started_at,
	prompt_plan_json: active.prompt_plan_json,
	prompt_inspection_json: active.prompt_inspection_json,
	prompt_context_json: active.prompt_context_json,
	lore_activation_json: active.lore_activation_json,
	memory_activation_json: active.memory_activation_json,
	generation_settings_json: active.generation_settings_json,
	connection_json: active.connection_json,
	generation_intent_json: active.generation_intent_json,
	checkpoint_event_id: active.checkpoint_event_id,
	checkpointed_at: active.checkpointed_at,
});

const retainTerminalInspection = (
	db: ConversationDatabase,
	active: ActiveGenerationRow,
	data: readonly ConversationDataEntry[],
	content: string,
	reasoning: string | undefined,
): void => {
	const terminalAt = new Date();
	const replay: typeof generationReplayTable.$inferInsert = {
		...replayCarriedColumns(active),
		checkpoint_content: content,
		checkpoint_reasoning: reasoning ?? active.checkpoint_reasoning,
		terminal_status: terminalStatusFrom(data),
		terminal_at: terminalAt.toISOString(),
		expires_at: new Date(terminalAt.getTime() + GENERATION_REPLAY_RETENTION_MS).toISOString(),
	};
	db.insert(generationReplayTable).values(replay).run();
};

const terminalProvenance = (
	active: { provenance_namespace: string | null; provenance_key: string | null; provenance_value: string | null },
	data: readonly ConversationDataEntry[],
): ConversationDataEntry | undefined => {
	if (active.provenance_namespace === null || active.provenance_key === null || active.provenance_value === null) return undefined;
	return {
		namespace: active.provenance_namespace,
		key: active.provenance_key,
		value: generationProvenanceCodec.encode(generationProvenanceCodec.project(
			parseGenerationJson(active.provenance_value, null),
			readGenerationTerminalMetadata(data),
		)),
	};
};

const terminalMacroData = (active: ActiveGenerationRow): ConversationDataEntry[] => {
	if (active.macro_preset_id === null) return [];
	let writes;
	try {
		writes = parseMacroWrites(active.macro_writes_json);
	} catch (error) {
		throw new InvalidConversationCommandError(error instanceof Error ? error.message : "The Active Generation has invalid persisted macro writes.");
	}
	return macroWritesToData(active.macro_preset_id, writes);
};

const terminalLoreActivationData = (active: ActiveGenerationRow): ConversationDataEntry[] => {
	let value;
	try {
		value = parseLoreActivationRecord(active.lore_activation_json);
	} catch (error) {
		throw new InvalidConversationCommandError(
			error instanceof Error ? error.message : "The Active Generation has invalid persisted Lore Activation evidence.",
		);
	}
	if (value === null) return [];
	return [{
		namespace: LORE_ACTIVATION_NAMESPACE,
		key: LORE_ACTIVATION_KEY,
		value: active.lore_activation_json,
	}];
};

const terminalMemoryActivationData = (active: ActiveGenerationRow): ConversationDataEntry[] => {
	let value;
	try {
		value = parseMemoryActivationRecord(active.memory_activation_json);
	} catch (error) {
		throw new InvalidConversationCommandError(error instanceof Error ? error.message : "The Active Generation has invalid persisted Memory Activation evidence.");
	}
	if (value === null) return [];
	return [{ namespace: MEMORY_ACTIVATION_NAMESPACE, key: MEMORY_ACTIVATION_KEY, value: active.memory_activation_json }];
};

/**
 * ==[HUMAN APPROVED]== Persist one terminal Variant's Conversation-scoped data: the compact
 * generation provenance first, then the lifecycle's private reasoning
 * (unless the supplied entries already carry one), then the supplied
 * entries in order. Shared by resolve and stop so the row order and the
 * reasoning dedupe rule cannot drift.
 */
export const persistTerminalVariantData = (
	db: ConversationDatabase,
	variantId: number,
	input: {
		provenance: ConversationDataEntry | undefined;
		reasoning?: string | undefined;
		suppliedData: readonly ConversationDataEntry[];
		macroData?: readonly ConversationDataEntry[];
		loreActivationData?: readonly ConversationDataEntry[];
		memoryActivationData?: readonly ConversationDataEntry[];
	},
): void => {
	const suppliedData = input.suppliedData.filter((entry) =>
		entry.namespace !== LORE_ACTIVATION_NAMESPACE && entry.namespace !== MEMORY_ACTIVATION_NAMESPACE,
	);
	const data = [
		...(input.macroData ?? []),
		...(input.loreActivationData ?? []),
		...(input.memoryActivationData ?? []),
		...(input.provenance === undefined ? [] : [input.provenance]),
		...(input.reasoning !== undefined && input.reasoning.length > 0 &&
			!suppliedData.some((entry) => entry.namespace === "generation" && entry.key === "reasoning")
			? [{ namespace: "generation", key: "reasoning", value: input.reasoning }]
			: []),
		...suppliedData,
	];
	if (data.length > 0) {
		db.insert(messageVariantDataTable)
			.values(data.map((entry) => ({
				message_variant_id: variantId,
				namespace: entry.namespace,
				key: entry.key,
				value: entry.value,
			})))
			.run();
	}
};

// ==[HUMAN APPROVED]== The durable terminal commit against an already-open transaction:
// validate the provisional target, write terminal content, persist terminal
// Variant data, retain bounded inspection data, and remove the Active
// Generation row. Shared by resolution and Stop's durable-output branch so
// the terminal mutation is written once. Revision advancement stays with the
// public commands.
function commitDurableTerminalGenerationInTransaction(
	db: ConversationDatabase,
	active: ActiveGenerationRow,
	input: {
		content: string;
		reasoning: string | undefined;
		timestamp: string;
		suppliedData: readonly ConversationDataEntry[];
	},
): void {
	const variant = db
		.select({ id: messageVariantTable.id })
		.from(messageVariantTable)
		.where(
			and(
				eq(messageVariantTable.id, active.variant_id),
				eq(messageVariantTable.message_id, active.message_id),
			),
		)
		.get();
	if (variant === undefined) {
		throw new InvalidConversationCommandError("The provisional Variant is no longer available.");
	}
	db.update(messageVariantTable)
		.set({ content: input.content, timestamp: input.timestamp })
		.where(eq(messageVariantTable.id, variant.id))
		.run();
	persistTerminalVariantData(db, variant.id, {
		provenance: terminalProvenance(active, input.suppliedData),
		reasoning: input.reasoning,
		suppliedData: input.suppliedData,
		macroData: terminalMacroData(active),
		loreActivationData: terminalLoreActivationData(active),
		memoryActivationData: terminalMemoryActivationData(active),
	});
	retainTerminalInspection(db, active, input.suppliedData, input.content, input.reasoning);
	db.delete(activeGenerationTable)
		.where(eq(activeGenerationTable.id, active.id))
		.run();
}

/**
 * ==[HUMAN APPROVED]== Resolving replaces the provisional content, writes compact terminal
 * provenance, retains inspection state, and removes the Active Generation record.
 * Tail, continuation, and sibling attempts all share this single resolution
 * seam by inspecting the target record directly. It advances the Conversation
 * revision exactly once as an authoritative lifecycle transition.
 */
export function resolveConversationGeneration(
	database: Database,
	input: ResolveGenerationInput,
): ConversationSummary {
	return runConversationTransaction(database, (db, reportChange) => {
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) {
			throw new InvalidConversationCommandError("The Active Generation is no longer available.");
		}
		commitDurableTerminalGenerationInTransaction(db, active, {
			content: input.content,
			reasoning: input.reasoning,
			timestamp: input.timestamp,
			suppliedData: input.data ?? [],
		});
		// ==[HUMAN APPROVED]== The terminal Variant content is committed; Memory re-derives
		// its collection from the resolved source.
		reportChange({
			conversationId: input.conversationId,
			touchedVariantIds: [active.variant_id],
			removedVariantIds: [],
			promptPresetChanged: false,
		});
		return advanceConversationRevision(db, input.conversationId, input.timestamp);
	});
}

/**
 * ==[HUMAN APPROVED]== Remove one accepted target. The persisted Active Generation row is
 * the sole authority for the mutation: a Sibling Generation loses only its
 * provisional Variant (restoring the acceptance-time selection unless a
 * later explicit selection took precedence), while a Tail or Continuation
 * Generation is its own provisional Message and is removed whole. The
 * caller never selects a mode, so a Sibling Generation ID cannot reach the
 * Message-removal path and delete the Message owning every sibling Variant.
 * Removal is the same destructive transition Stop applies to a target
 * without durable output, so both entry points share it.
 */
export const removeConversationGeneration = (
	database: Database,
	input: RemoveGenerationInput,
): ConversationSummary => {
	return runConversationTransaction(database, (db) => {
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) {
			throw new InvalidConversationCommandError(
				"The Active Generation is no longer available.",
			);
		}
		if (active.checkpoint_content.length > 0 || active.checkpoint_reasoning.length > 0) {
			throw new InvalidConversationCommandError("A Generation with durable output must be resolved or stopped.");
		}
		const transition = removeActiveGenerationTargetInTransaction(db, active);
		if (transition.removedSibling !== undefined) {
			restoreStoppedSiblingSelection(db, [transition.removedSibling]);
		}
		return advanceConversationRevision(db, input.conversationId);
	});
};

/**
 * ==[HUMAN APPROVED]== Persist one revision-neutral Generation checkpoint.
 *
 * The Active Generation row is the authoritative crash-recovery copy of both
 * streams and their application event position. The provisional Variant's
 * visible content is mirrored as well so a normal Conversation read remains
 * useful while the provider is still running. Reasoning stays active-only
 * until terminal resolution, keeping ordinary history free of partial private
 * reasoning.
 */
export function checkpointConversationGeneration(
	database: Database,
	input: CheckpointGenerationInput,
): void {
	runConversationTransaction(database, (db) => {
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) return;
		writeCheckpointInTransaction(db, active, input);
	});
}

// ==[HUMAN APPROVED]== The checkpoint write against an already-read Active Generation row:
// the monotonic event position guards delayed writes, the provisional
// Variant mirrors the visible content, and the crash-recovery copy stores
// both streams. Shared by the Tail and Sibling checkpoint seams.
function writeCheckpointInTransaction(
	db: ConversationDatabase,
	active: ActiveGenerationRow,
	input: CheckpointGenerationInput,
): void {
	const currentEventId = active.checkpoint_event_id;
	if (
		input.latestEventId !== undefined &&
		Number.isInteger(input.latestEventId) &&
		input.latestEventId < currentEventId
	) return;
	const eventId = input.latestEventId === undefined || !Number.isInteger(input.latestEventId)
		? currentEventId
		: Math.max(currentEventId, input.latestEventId);
	const values: CheckpointVariantValues = {
		content: input.content,
		...(input.timestamp === undefined ? undefined : { timestamp: input.timestamp }),
	};
	db.update(messageVariantTable)
		.set(values)
		.where(
			and(
				eq(messageVariantTable.id, active.variant_id),
				eq(messageVariantTable.message_id, active.message_id),
			),
		)
		.run();
	db.update(activeGenerationTable)
		.set({
			checkpoint_content: input.content,
			checkpoint_reasoning: input.reasoning ?? active.checkpoint_reasoning,
			checkpoint_event_id: eventId,
			checkpointed_at: input.timestamp ?? new Date().toISOString(),
		})
		.where(
			and(
				eq(activeGenerationTable.id, active.id),
				eq(activeGenerationTable.conversation_id, input.conversationId),
			),
		)
		.run();
}

interface StoppedSiblingTarget {
	messageId: number;
	variantId: number;
	priorVariantId: number | null;
	selected: boolean;
}

interface StopTransition {
	readonly durableOutput: boolean;
	readonly removedSibling?: StoppedSiblingTarget;
}

/**
 * ==[HUMAN APPROVED]== The destructive terminal transition: discard the provisional
 * target — the sibling Variant alone, or the whole provisional Message for
 * a Tail or Continuation target (which leaves a retriable accepted Human
 * Message when Send created one) — and report the removed sibling so the
 * caller can restore the selection the attempt displaced. Shared by Stop's
 * zero-output transition and the canonical removal so the destructive path
 * is written once.
 */
function removeActiveGenerationTargetInTransaction(
	db: ConversationDatabase,
	active: ActiveGenerationRow,
): StopTransition {
	if (isSiblingGenerationRow(active)) {
		const variant = db
			.select({ id: messageVariantTable.id, selected: messageVariantTable.selected })
			.from(messageVariantTable)
			.where(
				and(
					eq(messageVariantTable.id, active.variant_id),
					eq(messageVariantTable.message_id, active.message_id),
				),
			)
			.get();
		if (variant === undefined) {
			throw new InvalidConversationCommandError("The provisional sibling Variant is no longer available.");
		}
		db.update(activeGenerationTable)
			.set({ prior_variant_id: active.prior_variant_id })
			.where(and(
				eq(activeGenerationTable.message_id, active.message_id),
				eq(activeGenerationTable.prior_variant_id, variant.id),
			))
			.run();
		db.delete(activeGenerationTable)
			.where(eq(activeGenerationTable.id, active.id))
			.run();
		db.delete(messageVariantTable)
			.where(eq(messageVariantTable.id, variant.id))
			.run();
		return {
			durableOutput: false,
			removedSibling: {
				messageId: active.message_id,
				variantId: variant.id,
				priorVariantId: active.prior_variant_id,
				selected: variant.selected,
			},
		};
	}
	db.delete(activeGenerationTable)
		.where(eq(activeGenerationTable.id, active.id))
		.run();
	db.delete(messageTable)
		.where(
			and(
				eq(messageTable.id, active.message_id),
				eq(messageTable.conversation_id, active.conversation_id),
			),
		)
		.run();
	return { durableOutput: false };
}

/**
 * ==[HUMAN APPROVED]== Apply one Stop transition against an already-open transaction. Keeping
 * the row mutation here lets Stop and Stop All share exactly the same terminal
 * persistence rules while Stop All can commit the complete target set once.
 */
function stopActiveGenerationInTransaction(
	db: ConversationDatabase,
	active: ActiveGenerationRow,
	timestamp: string,
): StopTransition {
	const content = active.checkpoint_content;
	const reasoning = active.checkpoint_reasoning;
	if (content.length === 0 && reasoning.length === 0) {
		return removeActiveGenerationTargetInTransaction(db, active);
	}

	commitDurableTerminalGenerationInTransaction(db, active, {
		content,
		reasoning,
		timestamp,
		suppliedData: [
			{ namespace: "generation", key: "outcome", value: "interrupted" },
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
		] satisfies ConversationDataEntry[],
	});
	return { durableOutput: true };
}

function restoreStoppedSiblingSelection(
	db: ConversationDatabase,
	removed: readonly StoppedSiblingTarget[],
): void {
	const removedIds = new Set(removed.map((target) => target.variantId));
	const priorByVariantId = new Map(removed.map((target) => [target.variantId, target.priorVariantId]));
	for (const target of removed) {
		if (!target.selected) continue;
		let fallback = target.priorVariantId;
		while (fallback !== null && removedIds.has(fallback)) {
			fallback = priorByVariantId.get(fallback) ?? null;
		}
		if (fallback === null) continue;
		db.update(messageVariantTable)
			.set({ selected: true })
			.where(
				and(
					eq(messageVariantTable.id, fallback),
					eq(messageVariantTable.message_id, target.messageId),
				),
			)
			.run();
	}
}

// ==[HUMAN APPROVED]== Explicit Stop uses the latest durable checkpoint as its terminal input. A
// live runtime flushes immediately before calling this seam; a caller without
// a runtime still gets the last authoritative checkpoint and the same cleanup
// rules. The existing resolve/remove operations keep the transition atomic,
// and a race with a provider terminal event simply reports that the target is
// no longer available to the losing caller.
export function stopConversationGeneration(
	database: Database,
	input: StopGenerationInput,
): ConversationSummary {
	const timestamp = input.timestamp ?? new Date().toISOString();
	return runConversationTransaction(database, (db, reportChange) => {
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) {
			throw new InvalidConversationCommandError("The Active Generation is no longer available.");
		}
		const transition = stopActiveGenerationInTransaction(
			db,
			active,
			timestamp,
		);
		if (transition.removedSibling !== undefined) {
			restoreStoppedSiblingSelection(db, [transition.removedSibling]);
		}
		// ==[HUMAN APPROVED]== A durable Stop commits the terminal Variant content; a
		// zero-output Stop deletes the target whole, so its in-flight Memory
		// work is abandoned through the removed record.
		reportChange(transition.durableOutput ? {
			conversationId: input.conversationId,
			touchedVariantIds: [active.variant_id],
			removedVariantIds: [],
			promptPresetChanged: false,
		} : {
			conversationId: input.conversationId,
			touchedVariantIds: [],
			removedVariantIds: [active.variant_id],
			promptPresetChanged: false,
		});
		return advanceConversationRevision(
			db,
			input.conversationId,
			transition.durableOutput ? timestamp : undefined,
		);
	});
}

/**
 * ==[HUMAN APPROVED]== Atomically stop every Active Generation currently owned by a Conversation.
 * The result is the durable target set; callers must use it to settle only
 * runtimes whose Conversation transition actually committed.
 */
export function stopConversationGenerations(
	database: Database,
	input: StopGenerationsInput,
): StoppedGenerations {
	return runConversationTransaction(database, (db, reportChange) => {
		requireConversation(db, input.conversationId);
		const activeRows = db
			.select()
			.from(activeGenerationTable)
			.where(eq(activeGenerationTable.conversation_id, input.conversationId))
			.orderBy(asc(activeGenerationTable.id))
			.all();
		if (activeRows.length === 0) {
			throw new InvalidConversationCommandError("The Conversation has no active Generations to stop.");
		}
		const timestamp = input.timestamp ?? new Date().toISOString();
		const removedSiblings: StoppedSiblingTarget[] = [];
		const touchedVariantIds: number[] = [];
		const removedVariantIds: number[] = [];
		let durableOutput = false;
		for (const active of activeRows) {
			const transition = stopActiveGenerationInTransaction(db, active, timestamp);
			durableOutput ||= transition.durableOutput;
			if (transition.removedSibling !== undefined) removedSiblings.push(transition.removedSibling);
			if (transition.durableOutput) touchedVariantIds.push(active.variant_id);
			else removedVariantIds.push(active.variant_id);
		}
		restoreStoppedSiblingSelection(db, removedSiblings);
		reportChange({
			conversationId: input.conversationId,
			touchedVariantIds,
			removedVariantIds,
			promptPresetChanged: false,
		});
		const snapshot = advanceConversationRevision(
			db,
			input.conversationId,
			durableOutput ? timestamp : undefined,
		);
		return {
			generationIds: activeRows.map((active) => active.id),
			conversation: snapshot,
		};
	});
}
