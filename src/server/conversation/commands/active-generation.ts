import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import {
	activeGenerationTable,
	chatTable,
	generationReplayTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
} from "../../database/schema";
import {
	ConversationNotFoundError,
	InvalidConversationCommandError,
} from "../errors";
import type { ConversationDatabase } from "../internal";
import { advanceConversationRevision, runConversationTransaction } from "./transaction";
import type {
	ConversationDataEntry,
	ConversationSnapshot,
	CheckpointGenerationInput,
	RemoveGenerationInput,
	StopGenerationsInput,
	StoppedGenerations,
	StopGenerationInput,
	ResolveTailGenerationInput,
	ResolveSiblingGenerationInput,
} from "../types";
import { GENERATION_REPLAY_RETENTION_MS } from "../generation-retention";
import {
	generationProvenanceCodec,
	generationJsonObject,
	parseGenerationJson,
	readGenerationTerminalMetadata,
} from "../../../shared/generation-provenance";

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
			eq(activeGenerationTable.chat_id, conversationId),
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

const retainTerminalInspection = (
	db: ConversationDatabase,
	active: ActiveGenerationRow,
	data: readonly ConversationDataEntry[],
	content: string,
	reasoning: string | undefined,
): void => {
	const terminalAt = new Date();
	db.insert(generationReplayTable).values({
		id: active.id,
		chat_id: active.chat_id,
		message_id: active.message_id,
		variant_id: active.variant_id,
		human_participant_id: active.human_participant_id,
		model_participant_id: active.model_participant_id,
		captured_human_name: active.captured_human_name,
		captured_model_name: active.captured_model_name,
		started_at: active.started_at,
		prompt_plan_json: active.prompt_plan_json,
		prompt_inspection_json: active.prompt_inspection_json,
		history_roles_json: active.history_roles_json,
		generation_settings_json: active.generation_settings_json,
		connection_json: active.connection_json,
		generation_intent_json: active.generation_intent_json,
		checkpoint_content: content,
		checkpoint_reasoning: reasoning ?? active.checkpoint_reasoning,
		checkpoint_event_id: active.checkpoint_event_id,
		checkpointed_at: active.checkpointed_at,
		terminal_status: terminalStatusFrom(data),
		terminal_at: terminalAt.toISOString(),
		expires_at: new Date(terminalAt.getTime() + GENERATION_REPLAY_RETENTION_MS).toISOString(),
	}).run();
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
	},
): void => {
	const data = [
		...(input.provenance === undefined ? [] : [input.provenance]),
		...(input.reasoning !== undefined && input.reasoning.length > 0 &&
			!input.suppliedData.some((entry) => entry.namespace === "generation" && entry.key === "reasoning")
			? [{ namespace: "generation", key: "reasoning", value: input.reasoning }]
			: []),
		...input.suppliedData,
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

type ResolveGenerationInput =
	| ResolveTailGenerationInput
	| ResolveSiblingGenerationInput;

/**
 * ==[HUMAN APPROVED]== Resolve either kind of provisional target in one transaction. Tail and
 * continuation targets are model Messages; siblings are Variants on an
 * existing Message. Everything else about terminal persistence is shared.
 */
const resolveConversationGeneration = (
	database: Database,
	input: ResolveGenerationInput,
	mode: "tail" | "sibling",
): ConversationSnapshot => {
	return runConversationTransaction(database, (db) => {
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined || (mode === "sibling" && !isSiblingGenerationRow(active))) {
			throw new InvalidConversationCommandError(
				mode === "sibling"
					? "The Sibling Generation is no longer available."
					: "The Active Generation is no longer available.",
			);
		}
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
			throw new InvalidConversationCommandError(
				mode === "sibling"
					? "The provisional sibling Variant is no longer available."
					: "The provisional Variant is no longer available.",
			);
		}

		db.update(messageVariantTable)
			.set({ content: input.content, timestamp: input.timestamp })
			.where(eq(messageVariantTable.id, variant.id))
			.run();
		const suppliedData = input.data ?? [];
		persistTerminalVariantData(db, variant.id, {
			provenance: terminalProvenance(active, suppliedData),
			reasoning: input.reasoning,
			suppliedData,
		});
		retainTerminalInspection(db, active, suppliedData, input.content, input.reasoning);
		db.delete(activeGenerationTable)
			.where(eq(activeGenerationTable.id, active.id))
			.run();
		return advanceConversationRevision(db, input.conversationId, input.timestamp);
	});
};

// ==[HUMAN APPROVED]== Resolving a sibling keeps the target Message and its original Author Stamp
// intact; only the accepted provisional Variant becomes durable.
export function resolveConversationSiblingGeneration(
	database: Database,
	input: ResolveSiblingGenerationInput,
): ConversationSnapshot {
	return resolveConversationGeneration(database, input, "sibling");
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
): ConversationSnapshot => {
	return runConversationTransaction(database, (db) => {
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) {
			throw new InvalidConversationCommandError(
				"The Active Generation is no longer available.",
			);
		}
		const transition = removeActiveGenerationTargetInTransaction(db, active);
		if (transition.removedSibling !== undefined) {
			restoreStoppedSiblingSelection(db, [transition.removedSibling]);
		}
		return advanceConversationRevision(db, input.conversationId);
	});
};

// ==[HUMAN APPROVED]== Resolving replaces the provisional content and writes compact terminal
// provenance before removing the Active Generation record. It advances the
// Conversation revision exactly once as a lifecycle transition.
export function resolveConversationTailGeneration(
	database: Database,
	input: ResolveTailGenerationInput,
): ConversationSnapshot {
	return resolveConversationGeneration(database, input, "tail");
}

// ==[HUMAN APPROVED]== Sibling checkpoints share the same revision-neutral semantics as Tail
// checkpoints. The target is selected by the Active Generation id, never by
// a client-supplied Variant id, and the sibling gate rides the same single
// transactional read that guards the write.
export function checkpointConversationSiblingGeneration(
	database: Database,
	input: CheckpointGenerationInput,
): void {
	runConversationTransaction(database, (db) => {
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined || !isSiblingGenerationRow(active)) return;
		writeCheckpointInTransaction(db, active, input);
	});
}

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
	const values: CheckpointVariantValues = { content: input.content };
	if (input.timestamp !== undefined) values.timestamp = input.timestamp;
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
				eq(activeGenerationTable.chat_id, input.conversationId),
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
				eq(messageTable.chat_id, active.chat_id),
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
		.set({ content, timestamp })
		.where(eq(messageVariantTable.id, variant.id))
		.run();
	const suppliedData = [
		{ namespace: "generation", key: "outcome", value: "interrupted" },
		{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
	] satisfies ConversationDataEntry[];
	persistTerminalVariantData(db, variant.id, {
		provenance: terminalProvenance(active, suppliedData),
		reasoning,
		suppliedData,
	});
	retainTerminalInspection(db, active, suppliedData, content, reasoning);
	db.delete(activeGenerationTable)
		.where(eq(activeGenerationTable.id, active.id))
		.run();
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
): ConversationSnapshot {
	const timestamp = input.timestamp ?? new Date().toISOString();
	return runConversationTransaction(database, (db) => {
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
	return runConversationTransaction(database, (db) => {
		const conversation = db
			.select({ id: chatTable.id })
			.from(chatTable)
			.where(eq(chatTable.id, input.conversationId))
			.get();
		if (conversation === undefined) throw new ConversationNotFoundError(input.conversationId);
		const activeRows = db
			.select()
			.from(activeGenerationTable)
			.where(eq(activeGenerationTable.chat_id, input.conversationId))
			.orderBy(asc(activeGenerationTable.id))
			.all();
		if (activeRows.length === 0) {
			throw new InvalidConversationCommandError("The Conversation has no active Generations to stop.");
		}
		const timestamp = input.timestamp ?? new Date().toISOString();
		const removedSiblings: StoppedSiblingTarget[] = [];
		let durableOutput = false;
		for (const active of activeRows) {
			const transition = stopActiveGenerationInTransaction(db, active, timestamp);
			durableOutput ||= transition.durableOutput;
			if (transition.removedSibling !== undefined) removedSiblings.push(transition.removedSibling);
		}
		restoreStoppedSiblingSelection(db, removedSiblings);
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
