import type { Database } from "bun:sqlite";
import { and, eq, max } from "drizzle-orm";
import {
	activeGenerationTable,
	generationCaptureTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
} from "../../database/schema";
import { encodeGenerationCapture } from "../generation-capture";
import { SEED_KEY, SEED_NAMESPACE } from "../../box/seed";
import { readMessageMoves, writeMessageMoves } from "../../box/moves";
import { sameMoves } from "../../../shared/contract/box-generation";
import { hasMoves } from "../../../shared/contract/box-generation";
import {
	InvalidConversationCommandError,
} from "../errors";
import {
	appendSelectedVariant,
	insertMessage,
	insertVariant,
	readControlAssignment,
	requireConversation,
	requireConversationRevision,
	requireMessage,
	requireParticipant,
	type ConversationDatabase,
} from "../internal";
import {
	advanceConversationRevision,
	runConversationTransaction,
} from "./transaction";
import { generationGate } from "../generation-gate";
import type { AcceptedGeneration, CapturedGenerationTarget, GenerationAcceptanceCapture, ConversationJsonValue } from "../types";
import { requireGenerationTarget } from "../generation-target";
import { encodeMacroVariableWrite } from "../../../shared/contract/macro-variable-write";
import { isLoreActivationRecord } from "../../../shared/contract/lore-activation";
import { Value } from "@sinclair/typebox/value";
import { boxTraces } from "../../../shared/contract/box-generation";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";

const jsonText = (
	value: ConversationJsonValue,
	label: string,
): string => {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("undefined");
		return serialized;
	} catch {
		throw new InvalidConversationCommandError(
			`The captured ${label} could not be persisted as JSON.`,
		);
	}
};

interface PersistActiveGenerationInput extends GenerationAcceptanceCapture {
	humanMessageId: number | null;
	messageId: number;
	variantId: number;
	priorVariantId?: number | null;
	generationIntent: ConversationJsonValue;
}

/** @approved Persist the common server-owned Generation record after target creation. */
const persistActiveGeneration = (
	db: ConversationDatabase,
	input: PersistActiveGenerationInput,
): number => {
	writeVariantSeed(db, input.variantId, input.seed);
	const loreActivation = input.loreActivation ?? null;
	if (loreActivation !== null && !isLoreActivationRecord(loreActivation)) {
		throw new InvalidConversationCommandError(
			"The Lore Activation Record does not match the canonical schema.",
		);
	}
	const traces = input.boxTraces ?? {};
	if (!Value.Check(boxTraces, traces)) throw new InvalidConversationCommandError("The Box traces do not match their schema.");
	const active = db
		.insert(activeGenerationTable)
		.values({
			conversation_id: input.conversationId,
			human_message_id: input.humanMessageId,
			message_id: input.messageId,
			variant_id: input.variantId,
			prior_variant_id: input.priorVariantId ?? null,
			human_participant_id: input.humanParticipantId,
			model_participant_id: input.modelParticipantId,
			captured_human_name: input.capturedHumanName,
			captured_model_name: input.capturedModelName,
			started_at: input.timestamp,
			lore_activation_json: jsonText(loreActivation, "Lore activation evidence"),
			box_traces_json: jsonText(traces, "Box traces"),
			generation_intent_json: jsonText(input.generationIntent, "Generation intent"),
			provenance_namespace: input.provenance?.namespace ?? null,
			provenance_key: input.provenance?.key ?? null,
			provenance_value: input.provenance?.value ?? null,
			macro_preset_id: input.macro?.presetId ?? null,
			box_records_json: JSON.stringify(input.boxRecords ?? {}),
			macro_writes_json: jsonText(
				(input.macro?.writes ?? []).map(encodeMacroVariableWrite),
				"Macro writes",
			),
		})
		.returning({ id: activeGenerationTable.id })
		.get();
	if (active === undefined) {
		throw new InvalidConversationCommandError(
			"The Active Generation could not be persisted.",
		);
	}
	const capture = `{"modelId":${JSON.stringify(input.modelId)},"promptPlan":${jsonText(input.promptPlan, "Prompt Plan")},"promptInspection":${jsonText(input.promptInspection, "Prompt inspection")}}`;
	db.insert(generationCaptureTable)
		.values({ generation_id: active.id, ...encodeGenerationCapture(capture) })
		.run();
	return active.id;
};

interface ProvisionalModelTargetInput {
	conversationId: number;
	timestamp: string;
	humanParticipantId: number;
	modelParticipantId: number;
	/** @approved The next Message position, read once by the lifecycle's validation. */
	position: number;
}

const writeVariantSeed = (db: ConversationDatabase, variantId: number, seed: string) =>
	db.insert(messageVariantDataTable).values({ message_variant_id: variantId, namespace: SEED_NAMESPACE, key: SEED_KEY, value: seed }).run();

interface ProvisionalModelTarget {
	modelMessageId: number;
	provisionalVariantId: number;
}

interface ProvisionalSiblingVariant {
	provisionalVariantId: number;
	priorVariantId: number | null;
}

/** @approved Create the model Message and its selected empty Variant as one target. */
const createProvisionalModelTarget = (
	db: ConversationDatabase,
	input: ProvisionalModelTargetInput,
): ProvisionalModelTarget => {
	const model = requireParticipant(db, input.conversationId, input.modelParticipantId);
	const modelMessageId = insertMessage(db, {
		conversationId: input.conversationId,
		position: input.position,
		timestamp: input.timestamp,
		author: { participantId: model.id, name: model.name },
		context: {
			humanParticipantId: input.humanParticipantId,
			modelParticipantId: model.id,
		},
	});
	const provisionalVariantId = insertVariant(db, {
		messageId: modelMessageId,
		position: 1,
		content: "",
		timestamp: input.timestamp,
		selected: true,
	});
	return { modelMessageId, provisionalVariantId };
};

const createProvisionalSiblingVariant = (
	db: ConversationDatabase,
	messageId: number,
	timestamp: string,
): ProvisionalSiblingVariant => {
	const priorVariantId = db
		.select({ id: messageVariantTable.id })
		.from(messageVariantTable)
		.where(
			and(
				eq(messageVariantTable.message_id, messageId),
				eq(messageVariantTable.selected, true),
			),
		)
		.get()?.id ?? null;
	const provisionalVariantId = appendSelectedVariant(db, {
		messageId,
		content: "",
		timestamp,
	});
	return { provisionalVariantId, priorVariantId };
};

// @approved
//  One Human Message's selected Variants as the Memory change record
// for Tail acceptance; the replace-or-create Human Message is the only
// accepted state Memory re-derives.
const tailHumanChange = (
	db: ConversationDatabase,
	conversationId: number,
	humanMessageId: number,
): ConversationWriteChange => ({
	conversationId,
	touchedVariantIds: db
		.select({ id: messageVariantTable.id })
		.from(messageVariantTable)
		.where(
			and(
				eq(messageVariantTable.message_id, humanMessageId),
				eq(messageVariantTable.selected, true),
			),
		)
		.all()
		.map(({ id }) => id),
	removedVariantIds: [],
});

// @approved
// Siblings reserve Variants without a revision check; Send and Continue
// require the revision captured before preparation. Validation order is observable.
export function acceptGeneration(
	database: Database,
	input: GenerationAcceptanceCapture,
	target: CapturedGenerationTarget,
): AcceptedGeneration {
	return runConversationTransaction(database, (db, reportChange) => {
		if (target.kind === "sibling") requireConversation(db, input.conversationId);
		else requireConversationRevision(db, input.conversationId, input.expectedRevision, "generation");
		if (target.kind === "send" && target.content.trim() === "" && !hasMoves(target.moves)) {
			throw new InvalidConversationCommandError("Send requires composer content or Moves.");
		}
		if (input.humanParticipantId === input.modelParticipantId) {
			throw new InvalidConversationCommandError(target.kind === "sibling"
				? "A Sibling Generation requires distinct historical Participants."
				: `A ${target.kind === "send" ? "Tail" : "Continuation"} Generation requires distinct human and model Participants.`);
		}
		if (target.kind !== "sibling") {
			const control = readControlAssignment(db, input.conversationId);
			if (control.humanParticipantId !== input.humanParticipantId || control.modelParticipantId !== input.modelParticipantId) {
				throw new InvalidConversationCommandError("The captured Control pair is no longer authoritative.");
			}
		}
		const human = requireParticipant(db, input.conversationId, input.humanParticipantId);
		if (target.kind !== "sibling") {
			const model = requireParticipant(db, input.conversationId, input.modelParticipantId);
			if (model.name !== input.capturedModelName) {
				throw new InvalidConversationCommandError("The captured model Author Stamp is no longer authoritative.");
			}
		}
		let humanMessageId: number | null = null;
		let priorVariantId: number | null = null;
		let messageId: number;
		let provisionalVariantId: number;
		switch (target.kind) {
			case "send": {
				generationGate(db, input.conversationId, { type: "accept-tail" });
				let position: number;
				const reused = target.reuseHumanMessageId === undefined
					? undefined
					: requireMessage(db, input.conversationId, target.reuseHumanMessageId);
				const latestPosition = db
					.select({ value: max(messageTable.position) })
					.from(messageTable)
					.where(eq(messageTable.conversation_id, input.conversationId))
					.get()?.value;
				if (reused !== undefined) {
					const selected = db
						.select({ content: messageVariantTable.content })
						.from(messageVariantTable)
						.where(
							and(
								eq(messageVariantTable.message_id, reused.id),
								eq(messageVariantTable.selected, true),
							),
						)
						.get();
					if (
						reused.position !== latestPosition ||
						reused.author_participant_id !== human.id ||
						reused.author_name !== human.name ||
						selected?.content !== target.content ||
						!sameMoves(readMessageMoves(db, input.conversationId, [reused.id]).get(reused.id), target.moves)
					) {
						throw new InvalidConversationCommandError(
							"The unanswered human Message cannot be reused for this Send.",
						);
					}
					humanMessageId = reused.id;
					position = (latestPosition ?? 0) + 1;
				} else {
					humanMessageId = insertMessage(db, {
						conversationId: input.conversationId,
						position: (latestPosition ?? 0) + 1,
						timestamp: input.timestamp,
						author: { participantId: human.id, name: human.name },
						context: null,
					});
					insertVariant(db, {
						messageId: humanMessageId,
						position: 1,
						content: target.content,
						timestamp: input.timestamp,
						selected: true,
					});
					writeMessageMoves(db, humanMessageId, target.moves ?? {});
					position = (latestPosition ?? 0) + 2;
				}
				const provisional = createProvisionalModelTarget(db, { ...input, position });
				messageId = provisional.modelMessageId;
				provisionalVariantId = provisional.provisionalVariantId;
				break;
			}
			case "continuation": {
				generationGate(db, input.conversationId, { type: "accept-continuation" });
				const preceding = requireGenerationTarget(db, input.conversationId, {
					kind: "continuation", strategy: target.intent.strategy,
					preceding: { messageId: target.precedingMessageId, variantId: target.precedingVariantId },
				});
				const provisional = createProvisionalModelTarget(db, { ...input, position: preceding.position + 1 });
				messageId = provisional.modelMessageId;
				provisionalVariantId = provisional.provisionalVariantId;
				break;
			}
			case "sibling": {
				const historicalContext = requireGenerationTarget(db, input.conversationId, target);
				if (historicalContext.humanParticipantId !== input.humanParticipantId || historicalContext.modelParticipantId !== input.modelParticipantId) {
					throw new InvalidConversationCommandError("The captured historical Control pair does not match the target Message.");
				}
				generationGate(db, input.conversationId, { type: "accept-sibling", messageId: target.messageId });
				messageId = target.messageId;
				({ provisionalVariantId, priorVariantId } = createProvisionalSiblingVariant(db, messageId, input.timestamp));
				break;
			}
		}
		const generationId = persistActiveGeneration(db, {
			...input, humanMessageId, messageId, variantId: provisionalVariantId, priorVariantId,
			generationIntent: target.kind === "continuation" ? target.intent : { type: target.kind === "send" ? "tail" : "sibling" },
		});
		const conversation = advanceConversationRevision(db, input.conversationId, input.timestamp);
		if (humanMessageId !== null) reportChange(tailHumanChange(db, input.conversationId, humanMessageId));
		return { generationId, humanMessageId, messageId, provisionalVariantId, priorVariantId, conversation };
	});
}
