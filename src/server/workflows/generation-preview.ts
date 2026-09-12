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
	participatingHistoryFor,
	type GenerationAttemptKind,
	type ParticipatingHistory,
	type ContinuationGenerationCapture,
	type SendGenerationCapture,
	type CapturedGeneration,
} from "./generate-capture";
import { createConversationModule } from "../conversation";
import { readConversationPromptPresetRecipe } from "../prompt-preset";
import { conversationGenerationSettings, promptPlan } from "../../shared/contract/conversation-schema";
import { ConversationNotFoundError, InvalidConversationCommandError } from "../conversation";
import { deriveMacroState, readMacroWrites } from "../prompt-macros";
import type { GenerationFormattingContext } from "../../shared/contract/conversation-schema";

export type GenerationPreviewKind = GenerationAttemptKind;

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
	readonly expiresAt: number;
}

export interface GenerationPreviewRequest {
	readonly kind: GenerationPreviewKind;
	readonly conversationId: number;
	readonly content?: string;
	readonly messageId?: number;
	readonly formatting?: GenerationFormattingContext;
	readonly connection?: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions;
	readonly tokenEstimator?: TokenEstimator;
}

// ==[HUMAN APPROVED]== One process-local inspected-plan session per Conversation. Replacing a
// preview abandons the previous plan immediately, so the store is bounded by
// Conversations rather than inspection requests. The expiry is a leak guard
// for abandoned Conversations; it is not part of fingerprint staleness.
const previews = new Map<number, GenerationPreviewRecord>();
export const GENERATION_PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000;
const GENERATION_PREVIEW_SWEEP_INTERVAL_MS = 60 * 1000;

export const sweepExpiredGenerationPreviews = (now: number = Date.now()): void => {
	for (const [conversationId, preview] of previews) {
		if (preview.expiresAt <= now) previews.delete(conversationId);
	}
};

let previewSweepTimer: ReturnType<typeof setInterval> | undefined;
const ensureScheduledPreviewSweep = (): void => {
	if (previewSweepTimer !== undefined) return;
	previewSweepTimer = setInterval(
		sweepExpiredGenerationPreviews,
		GENERATION_PREVIEW_SWEEP_INTERVAL_MS,
	);
	previewSweepTimer.unref();
};

// ==[HUMAN APPROVED]== Simulates a server restart: inspected plans are process-local and therefore
// cannot be resumed by a new process. The next send must refresh the plan.
export const clearGenerationPreviewRegistry = (): void => {
	previews.clear();
};

const relevantMessages = (
	participatingMessages: ParticipatingHistory["messages"],
	presetId: number,
) => {
	return participatingMessages
		.map((message) => ({
			id: message.id,
			position: message.position,
			author: message.author === null ? null : {
				participantId: message.author.participantId,
				capturedName: message.author.capturedName,
			},
			historicalContext: message.historicalContext,
			variant: (() => {
				const selected = message.variants.find((variant) => variant.selected);
				return selected === undefined ? null : {
					id: selected.id,
					position: selected.position,
					content: selected.content,
					writes: readMacroWrites(selected.data, presetId),
				};
			})(),
		}));
};

const relevantParticipants = (
	snapshot: ConversationSnapshot,
	participation: ParticipatingHistory,
) => {
	const pair = participation.control;
	return [pair.humanParticipantId, pair.modelParticipantId]
		.map((id) => snapshot.cast.find((participant) => participant.id === id))
		.filter((participant): participant is NonNullable<typeof participant> => participant !== undefined)
		.map((participant) => ({
			id: participant.id,
			name: participant.name,
			prompt: participant.prompt,
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
	input: Pick<GenerationPreviewRequest, "kind" | "content" | "messageId" | "formatting" | "connection">,
): string => {
	const recipe = readConversationPromptPresetRecipe(database, snapshot.id);
	const settings = createConversationModule(database).getGenerationSettings(snapshot.id);
	if (recipe === undefined || settings === undefined) {
		throw new InvalidConversationCommandError("The Conversation's generation inputs are unavailable.");
	}
	if (!Value.Check(conversationGenerationSettings, settings)) {
		throw new InvalidConversationCommandError("The Conversation's Generation Settings are invalid.");
	}
	const participation = participatingHistoryFor(snapshot, input.kind, input.messageId);
	return JSON.stringify({
		kind: input.kind,
		content: input.content ?? null,
		messageId: input.messageId ?? null,
		timeZone: input.formatting?.timeZone ?? null,
		locale: input.formatting?.locale ?? null,
		control: participation.control,
		participants: relevantParticipants(snapshot, participation),
		recipe,
		settings,
		macroState: [...deriveMacroState({
			initialData: snapshot.data,
			presetId: recipe.id,
			selectedVariants: participation.messages
				.map((message) => {
					const selected = message.variants.find((variant) => variant.selected);
					return { selected: selected !== undefined, data: selected?.data ?? [] };
				}),
		})],
		connection: input.connection === undefined || input.connection === null
			? input.connection ?? null
			: {
				profileId: input.connection.profileId,
				settingsRevision: input.connection.settingsRevision,
				backend: input.connection.backend,
				adapter: input.connection.adapter,
				apiFormat: input.connection.apiFormat,
			},
		messages: relevantMessages(participation.messages, recipe.id),
	});
};

const ensureRecord = (id: string, conversationId: number): GenerationPreviewRecord => {
	sweepExpiredGenerationPreviews();
	const record = previews.get(conversationId);
	if (record === undefined || record.id !== id) {
		throw new InvalidConversationCommandError(
			"The inspected Prompt Plan is unavailable. Refresh it after a server restart or when it has been abandoned.",
		);
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
	ensureScheduledPreviewSweep();
	sweepExpiredGenerationPreviews();
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
			capture: captureSendGeneration({
				database,
				snapshot,
				content: input.content!,
				connection: input.connection,
				connectionSettings: input.connectionSettings,
				tokenEstimator: input.tokenEstimator,
				formatting: input.formatting,
			}),
			content: input.content!,
		}
		: input.kind === "continuation"
			? {
					kind: "continuation" as const,
					capture: captureContinuationGeneration({
						database,
						snapshot,
						connection: input.connection,
						connectionSettings: input.connectionSettings,
						tokenEstimator: input.tokenEstimator,
						formatting: input.formatting,
					}),
				}
			: {
					kind: "sibling" as const,
					capture: captureSiblingGeneration({
						database,
						snapshot,
						messageId: input.messageId!,
						connection: input.connection,
						connectionSettings: input.connectionSettings,
						tokenEstimator: input.tokenEstimator,
						formatting: input.formatting,
					}),
					messageId: input.messageId!,
				};
	const now = Date.now();
	const record: GenerationPreviewRecord = {
		id: crypto.randomUUID(),
		conversationId: input.conversationId,
		fingerprint: generationPreviewFingerprint(database, snapshot, {
			...input,
			connection: capture.capture.connection,
		}),
		capture,
		createdAt: now,
		expiresAt: now + GENERATION_PREVIEW_SESSION_TTL_MS,
	};
	previews.set(record.conversationId, record);
	return record;
};

export const previewRecordFor = (id: string, conversationId: number): GenerationPreviewRecord => ensureRecord(id, conversationId);

export const generationCaptureForPreview = (
	database: Database,
	snapshot: ConversationSnapshot,
	record: GenerationPreviewRecord,
	editedPlan: PromptPlan,
	connection: ModelClientConnectionSnapshot | null | undefined,
	input: Pick<GenerationPreviewRequest, "content" | "messageId" | "formatting">,
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
		formatting: input.formatting,
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
