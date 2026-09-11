import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import {
	budgetEditedPromptPlan,
	PromptBudgetExceededError,
	type PromptPlan,
	type TokenEstimator,
} from "../prompt-compiler";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ModelClientConnectionSnapshot } from "../model-client";
import type { ConversationSnapshot } from "../conversation";
import {
	captureContinuationGeneration,
	captureSendGeneration,
	captureSiblingGeneration,
	type ContinuationGenerationCapture,
	type SendGenerationCapture,
	type CapturedGeneration,
} from "./generate-capture";
import { createConversationModule } from "../conversation";
import { readConversationPromptPresetRecipe } from "../prompt-preset";
import { conversationGenerationSettings, promptPlan } from "../../shared/contract/conversation-schema";
import { ConversationNotFoundError, InvalidConversationCommandError } from "../conversation";

export type GenerationPreviewKind = "send" | "continuation" | "sibling";

export type GenerationPreviewCapture =
	| { kind: "send"; capture: SendGenerationCapture; content: string }
	| { kind: "continuation"; capture: ContinuationGenerationCapture }
	| { kind: "sibling"; capture: CapturedGeneration; messageId: number };

export interface GenerationPreviewRecord {
	readonly id: string;
	readonly conversationId: number;
	readonly fingerprint: string;
	readonly capture: GenerationPreviewCapture;
	readonly createdAt: number;
}

export interface GenerationPreviewRequest {
	readonly kind: GenerationPreviewKind;
	readonly conversationId: number;
	readonly content?: string;
	readonly messageId?: number;
	readonly timeZone?: string;
	readonly locale?: string;
	readonly connection?: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions;
	readonly tokenEstimator?: TokenEstimator;
}

const previews = new Map<string, GenerationPreviewRecord>();
const PREVIEW_RETENTION_MS = 15 * 60 * 1000;

const relevantMessages = (
	snapshot: ConversationSnapshot,
	kind: GenerationPreviewKind,
	messageId: number | undefined,
) => {
	const end = kind === "sibling" && messageId !== undefined
		? snapshot.messages.findIndex((message) => message.id === messageId)
		: snapshot.messages.length;
	return snapshot.messages
		.slice(0, end < 0 ? snapshot.messages.length : end)
		.map((message) => ({
			id: message.id,
			position: message.position,
			author: message.author,
			historicalContext: message.historicalContext,
			variant: message.variants.find((variant) => variant.selected) ?? null,
		}));
};

const relevantParticipants = (
	snapshot: ConversationSnapshot,
	kind: GenerationPreviewKind,
	messageId: number | undefined,
) => {
	const target = kind === "sibling" && messageId !== undefined
		? snapshot.messages.find((message) => message.id === messageId)
		: undefined;
	const pair = target?.historicalContext ?? snapshot.control;
	return [pair.humanParticipantId, pair.modelParticipantId]
		.map((id) => snapshot.cast.find((participant) => participant.id === id))
		.filter((participant): participant is NonNullable<typeof participant> => participant !== undefined)
		.map((participant) => ({
			id: participant.id,
			name: participant.name,
			prompt: participant.prompt,
			openings: participant.openings,
		}));
};

/**
 * ==[HUMAN APPROVED]== Fingerprint only the inputs which can change the compiled attempt. Revision
 * is intentionally absent: an unrelated Conversation edit must not force a
 * refresh, while selected history, definitions, preset, settings, and macro
 * state all remain explicit.
 */
export const generationPreviewFingerprint = (
	database: Database,
	snapshot: ConversationSnapshot,
	input: Pick<GenerationPreviewRequest, "kind" | "content" | "messageId" | "timeZone" | "locale" | "connection">,
): string => {
	const recipe = readConversationPromptPresetRecipe(database, snapshot.id);
	const settings = createConversationModule(database).getGenerationSettings(snapshot.id);
	if (recipe === undefined || settings === undefined) {
		throw new InvalidConversationCommandError("The Conversation's generation inputs are unavailable.");
	}
	if (!Value.Check(conversationGenerationSettings, settings)) {
		throw new InvalidConversationCommandError("The Conversation's Generation Settings are invalid.");
	}
	const target = input.kind === "sibling" && input.messageId !== undefined
		? snapshot.messages.find((message) => message.id === input.messageId)
		: undefined;
	return JSON.stringify({
		kind: input.kind,
		content: input.content ?? null,
		messageId: input.messageId ?? null,
		timeZone: input.timeZone ?? null,
		locale: input.locale ?? null,
		control: target?.historicalContext ?? snapshot.control,
		participants: relevantParticipants(snapshot, input.kind, input.messageId),
		recipe,
		settings,
		connection: input.connection === undefined || input.connection === null
			? input.connection ?? null
			: {
				profileId: input.connection.profileId,
				settingsRevision: input.connection.settingsRevision,
				backend: input.connection.backend,
				adapter: input.connection.adapter,
				apiFormat: input.connection.apiFormat,
			},
		data: snapshot.data,
		messages: relevantMessages(snapshot, input.kind, input.messageId),
	});
};

const ensureRecord = (id: string, conversationId: number): GenerationPreviewRecord => {
	const record = previews.get(id);
	if (record === undefined || record.conversationId !== conversationId || Date.now() - record.createdAt > PREVIEW_RETENTION_MS) {
		previews.delete(id);
		throw new InvalidConversationCommandError("The Prompt Plan preview has expired. Refresh it before sending.");
	}
	return record;
};

const assertEditedPlanStructure = (source: PromptPlan, edited: PromptPlan): void => {
	if (edited.blocks.length !== source.blocks.length) {
		throw new InvalidConversationCommandError("The edited Prompt Plan must keep its assembled blocks.");
	}
	for (const [index, sourceBlock] of source.blocks.entries()) {
		const editedBlock = edited.blocks[index];
		if (
			editedBlock === undefined ||
			editedBlock.kind !== sourceBlock.kind ||
			(sourceBlock.kind === "history"
				? editedBlock.kind !== "history" || editedBlock.role !== sourceBlock.role || editedBlock.speakerName !== sourceBlock.speakerName
				: editedBlock.kind === "history" || editedBlock.role !== sourceBlock.role)
		) {
			throw new InvalidConversationCommandError("The edited Prompt Plan must keep its assembled block structure.");
		}
	}
};

export const createGenerationPreview = (
	database: Database,
	input: GenerationPreviewRequest,
): GenerationPreviewRecord => {
	const snapshot = createConversationModule(database).getSnapshot(input.conversationId);
	if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
	if (input.kind === "send" && input.content === undefined) {
		throw new InvalidConversationCommandError("Send preview requires composer content.");
	}
	if (input.kind === "sibling" && input.messageId === undefined) {
		throw new InvalidConversationCommandError("Sibling preview requires a target Message.");
	}
	const capture = input.kind === "send"
		? {
			kind: "send" as const,
			capture: captureSendGeneration(
				database,
				snapshot,
				input.content!,
				input.connection,
				input.connectionSettings,
				input.tokenEstimator,
				{ timeZone: input.timeZone, locale: input.locale },
				{ assertBudget: false },
			),
			content: input.content!,
		}
		: input.kind === "continuation"
			? {
					kind: "continuation" as const,
					capture: captureContinuationGeneration(
						database,
						snapshot,
						input.connection,
						input.connectionSettings,
						input.tokenEstimator,
						{ timeZone: input.timeZone, locale: input.locale },
						{ assertBudget: false },
					),
				}
			: {
					kind: "sibling" as const,
					capture: captureSiblingGeneration(database, snapshot, {
						messageId: input.messageId!,
						connection: input.connection,
						connectionSettings: input.connectionSettings,
						tokenEstimator: input.tokenEstimator,
						macroTimeZone: input.timeZone,
						macroLocale: input.locale,
						assertBudget: false,
					}),
					messageId: input.messageId!,
				};
	const record: GenerationPreviewRecord = {
		id: crypto.randomUUID(),
		conversationId: input.conversationId,
		fingerprint: generationPreviewFingerprint(database, snapshot, {
			...input,
			connection: capture.capture.connection,
		}),
		capture,
		createdAt: Date.now(),
	};
	previews.set(record.id, record);
	return record;
};

export const previewRecordFor = (id: string, conversationId: number): GenerationPreviewRecord => ensureRecord(id, conversationId);

export const generationCaptureForPreview = (
	database: Database,
	snapshot: ConversationSnapshot,
	record: GenerationPreviewRecord,
	editedPlan: PromptPlan,
	connection: ModelClientConnectionSnapshot | null | undefined,
	input: Pick<GenerationPreviewRequest, "content" | "messageId" | "timeZone" | "locale">,
): GenerationPreviewCapture => {
	const source = record.capture;
	const kind = source.kind;
	if (kind === "send" && input.content !== source.content) {
		throw new InvalidConversationCommandError("The submitted Human text changed. Refresh the Prompt Plan before sending.");
	}
	if (kind === "sibling" && input.messageId !== source.messageId) {
		throw new InvalidConversationCommandError("The target Message changed. Refresh the Prompt Plan before sending.");
	}
	const fingerprint = generationPreviewFingerprint(database, snapshot, {
		kind,
		content: kind === "send" ? source.content : undefined,
		messageId: kind === "sibling" ? source.messageId : undefined,
		timeZone: input.timeZone,
		locale: input.locale,
		connection,
	});
	if (fingerprint !== record.fingerprint) {
		throw new InvalidConversationCommandError("The Prompt Plan is stale. Refresh it before sending.");
	}
	if (!Value.Check(promptPlan, editedPlan)) {
		throw new InvalidConversationCommandError("The edited Prompt Plan has invalid structure.");
	}
	assertEditedPlanStructure(source.capture.plan.promptPlan, editedPlan);
	if (JSON.stringify(editedPlan.intent ?? null) !== JSON.stringify(source.capture.plan.promptPlan.intent ?? null)) {
		throw new InvalidConversationCommandError("The Generation intent cannot be changed in an inspected Prompt Plan.");
	}
	const settings = source.capture.plan.effectiveSettings;
	const budget = budgetEditedPromptPlan({
		plan: editedPlan,
		contextLimit: settings.contextLimit,
		responseBudget: settings.responseBudget,
		safetyAllowance: settings.safetyAllowance,
	});
	if (!budget.fits) throw new PromptBudgetExceededError(budget);
	const plan = { ...source.capture.plan, promptPlan: editedPlan, budget };
	if (kind === "send") return { ...source, capture: { ...source.capture, plan } };
	if (kind === "continuation") {
		const assistantPrefill = source.capture.assistantPrefill === undefined
			? undefined
			: {
				...source.capture.assistantPrefill,
				prefix: [...editedPlan.blocks].reverse().find((block) => block.kind === "history" && block.role === "model")?.content ?? source.capture.assistantPrefill.prefix,
			};
		return { ...source, capture: { ...source.capture, plan, assistantPrefill } };
	}
	return { ...source, capture: { ...source.capture, plan } };
};
