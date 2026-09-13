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
import {
	captureContinuationGeneration,
	captureSendGeneration,
	captureSiblingGeneration,
	generationPreparationFingerprint,
	prepareGenerationInputs,
	type GenerationAttemptKind,
	type ContinuationGenerationCapture,
	type SendGenerationCapture,
	type CapturedGeneration,
} from "./generate-capture";
import { promptPlan } from "../../shared/contract/conversation-schema";
import { InvalidConversationCommandError } from "../conversation";
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
				conversationId: input.conversationId,
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
					conversationId: input.conversationId,
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
					conversationId: input.conversationId,
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
		fingerprint: generationPreparationFingerprint(capture.capture.preparation),
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
	conversationId: number,
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
	const preparation = prepareGenerationInputs({
		database,
		conversationId,
		kind,
		content: kind === "send" ? source.content : undefined,
		messageId: kind === "sibling" ? source.messageId : undefined,
		formatting: input.formatting,
		connection,
	});
	if (generationPreparationFingerprint(preparation) !== record.fingerprint) {
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
