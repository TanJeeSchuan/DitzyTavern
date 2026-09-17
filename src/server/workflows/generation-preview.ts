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
	captureContinuationGenerationAsync,
	captureSendGeneration,
	captureSendGenerationAsync,
	captureSiblingGeneration,
	captureSiblingGenerationAsync,
	prepareGenerationInputs,
	type ContinuationGenerationCapture,
	type SendGenerationCapture,
	type CapturedGeneration,
} from "./generate-capture";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { promptPlan } from "../../shared/contract/conversation-schema";
import { InvalidConversationCommandError } from "../conversation";
import type {
	GenerationFormattingContext,
	GenerationPreviewBody,
} from "../../shared/contract/conversation-schema";
import type { LoreActivationRecord } from "../../shared/lore-activation";

export type GenerationPreviewCapture =
	| { kind: "send"; capture: SendGenerationCapture; content: string }
	| { kind: "continuation"; capture: ContinuationGenerationCapture }
	| { kind: "sibling"; capture: CapturedGeneration; messageId: number };

export type GenerationPreviewKind = GenerationPreviewCapture["kind"];

interface GenerationPreviewRecordFields {
	readonly id: string;
	readonly conversationId: number;
	readonly fingerprint: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export type GenerationPreviewRecord = GenerationPreviewRecordFields & {
	readonly capture: GenerationPreviewCapture;
};

export type GenerationPreviewRecordFor<K extends GenerationPreviewKind> = GenerationPreviewRecordFields & {
	readonly capture: Extract<GenerationPreviewCapture, { kind: K }>;
};

export type GenerationPreviewAcceptanceFor<K extends GenerationPreviewKind> = {
	readonly kind: K;
	readonly record: GenerationPreviewRecordFor<K>;
	readonly editedPlan: PromptPlan;
};

export type GenerationPreviewAcceptance =
	| GenerationPreviewAcceptanceFor<"send">
	| GenerationPreviewAcceptanceFor<"continuation">
	| GenerationPreviewAcceptanceFor<"sibling">;

type WithoutFormatting<T> = T extends unknown ? Omit<T, "timeZone" | "locale"> : never;

export type GenerationPreviewRequest = WithoutFormatting<GenerationPreviewBody> & {
	readonly conversationId: number;
	readonly formatting?: GenerationFormattingContext;
	readonly connection?: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions;
	readonly tokenEstimator?: TokenEstimator;
};

const buildPreviewCapture = (
	database: Database,
	request: GenerationPreviewRequest,
): GenerationPreviewCapture => {
	const captureInput = {
		database,
		conversationId: request.conversationId,
		connection: request.connection,
		connectionSettings: request.connectionSettings,
		tokenEstimator: request.tokenEstimator,
		formatting: request.formatting,
	};
	switch (request.kind) {
		case "send":
			return {
				kind: "send",
				capture: captureSendGeneration({ ...captureInput, content: request.content }),
				content: request.content,
			};
		case "continuation":
			return {
				kind: "continuation",
				capture: captureContinuationGeneration(captureInput),
			};
		case "sibling":
			return {
				kind: "sibling",
				capture: captureSiblingGeneration({ ...captureInput, messageId: request.messageId }),
				messageId: request.messageId,
			};
	}
};

const buildPreviewCaptureAsync = async (
	database: Database,
	request: GenerationPreviewRequest,
): Promise<GenerationPreviewCapture> => {
	const captureInput = {
		database,
		conversationId: request.conversationId,
		connection: request.connection,
		connectionSettings: request.connectionSettings,
		tokenEstimator: request.tokenEstimator,
		formatting: request.formatting,
	};
	switch (request.kind) {
		case "send":
			return { kind: "send", capture: await captureSendGenerationAsync({ ...captureInput, content: request.content }), content: request.content };
		case "continuation":
			return { kind: "continuation", capture: await captureContinuationGenerationAsync(captureInput) };
		case "sibling":
			return { kind: "sibling", capture: await captureSiblingGenerationAsync({ ...captureInput, messageId: request.messageId }), messageId: request.messageId };
	}
};

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

const isPreviewRecordFor = <K extends GenerationPreviewKind>(
	record: GenerationPreviewRecord,
	kind: K,
): record is GenerationPreviewRecordFor<K> => record.capture.kind === kind;

export const previewRecordFor = <K extends GenerationPreviewKind>(
	id: string,
	conversationId: number,
	kind: K,
): GenerationPreviewRecordFor<K> => {
	const record = ensureRecord(id, conversationId);
	if (!isPreviewRecordFor(record, kind)) {
		throw new InvalidConversationCommandError("The Prompt Plan preview intent does not match this Generation.");
	}
	return record;
};

export const consumeGenerationPreview = (
	record: Pick<GenerationPreviewRecord, "id" | "conversationId">,
): void => {
	const current = previews.get(record.conversationId);
	if (current?.id !== record.id) {
		throw new InvalidConversationCommandError(
			"The inspected Prompt Plan is unavailable. Refresh it after a server restart or when it has been abandoned.",
		);
	}
	previews.delete(record.conversationId);
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
	const capture = buildPreviewCapture(database, input);
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

/** ==[HUMAN APPROVED]== Asynchronous preview path used by the HTTP inspection route so semantic
 * activation is captured before the inspected plan is exposed. */
export const createGenerationPreviewAsync = async (
	database: Database,
	input: GenerationPreviewRequest,
): Promise<GenerationPreviewRecord> => {
	ensureScheduledPreviewSweep();
	sweepExpiredGenerationPreviews();
	const capture = await buildPreviewCaptureAsync(database, input);
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

const acceptedEditedPlan = (
	record: GenerationPreviewRecord,
	editedPlan: PromptPlan,
	preparation: CapturedGeneration["preparation"],
) => {
	if (generationPreparationFingerprint(preparation) !== record.fingerprint) {
		throw new InvalidConversationCommandError("The Prompt Plan is stale. Refresh it before sending.");
	}
	if (!Value.Check(promptPlan, editedPlan)) {
		throw new InvalidConversationCommandError("The edited Prompt Plan has invalid structure.");
	}
	assertEditedPlanStructure(record.capture.capture.plan.promptPlan, editedPlan);
	if (JSON.stringify(editedPlan.intent ?? null) !== JSON.stringify(record.capture.capture.plan.promptPlan.intent ?? null)) {
		throw new InvalidConversationCommandError("The Generation intent cannot be changed in an inspected Prompt Plan.");
	}
	const settings = record.capture.capture.plan.effectiveSettings;
	const budget = budgetEditedPromptPlan({
		plan: editedPlan,
		contextLimit: settings.contextLimit,
		responseBudget: settings.responseBudget,
		safetyAllowance: settings.safetyAllowance,
	});
	if (!budget.fits) throw new PromptBudgetExceededError(budget);
	const sourceLore = record.capture.capture.plan.loreActivation;
	const loreActivation = sourceLore === null
		? null
		: editedLoreActivation(sourceLore, editedPlan);
	return { ...record.capture.capture.plan, promptPlan: editedPlan, budget, loreActivation };
};

const editedLoreActivation = (
	source: LoreActivationRecord,
	plan: PromptPlan,
): LoreActivationRecord => {
	const finalLoreText = plan.blocks.find((block) => block.kind === "lore")?.content ?? "";
	return {
		...source,
		finalLoreText,
		manuallyEdited: finalLoreText !== source.automaticLoreText,
	};
};

interface PreviewAcceptanceContext {
	readonly database: Database;
	readonly conversationId: number;
	readonly connection: ModelClientConnectionSnapshot | null | undefined;
	readonly formatting: GenerationFormattingContext | undefined;
}

export const captureSendGenerationPreview = (
	context: PreviewAcceptanceContext & {
		readonly preview: GenerationPreviewAcceptanceFor<"send">;
		readonly content: string;
	},
): SendGenerationCapture => {
	const { database, conversationId, connection, formatting, preview, content } = context;
	ensureRecord(preview.record.id, conversationId);
	if (content !== preview.record.capture.content) {
		throw new InvalidConversationCommandError("The submitted Human text changed. Refresh the Prompt Plan before sending.");
	}
	const preparation = prepareGenerationInputs({
		database, conversationId, connection, formatting, kind: "send", content,
	});
	return {
		...preview.record.capture.capture,
		plan: acceptedEditedPlan(preview.record, preview.editedPlan, preparation),
	};
};

export const captureContinuationGenerationPreview = (
	context: PreviewAcceptanceContext & {
		readonly preview: GenerationPreviewAcceptanceFor<"continuation">;
	},
): ContinuationGenerationCapture => {
	const { database, conversationId, connection, formatting, preview } = context;
	ensureRecord(preview.record.id, conversationId);
	const preparation = prepareGenerationInputs({
		database, conversationId, connection, formatting, kind: "continuation",
	});
	const source = preview.record.capture.capture;
	const assistantPrefill = source.assistantPrefill === undefined
		? undefined
		: {
			...source.assistantPrefill,
			prefix: [...preview.editedPlan.blocks].reverse().find(
				(block) => block.kind === "history" && block.role === "model",
			)?.content ?? source.assistantPrefill.prefix,
		};
	return {
		...source,
		plan: acceptedEditedPlan(preview.record, preview.editedPlan, preparation),
		assistantPrefill,
	};
};

export const captureSiblingGenerationPreview = (
	context: PreviewAcceptanceContext & {
		readonly preview: GenerationPreviewAcceptanceFor<"sibling">;
		readonly messageId: number;
	},
): CapturedGeneration => {
	const { database, conversationId, connection, formatting, preview, messageId } = context;
	ensureRecord(preview.record.id, conversationId);
	if (messageId !== preview.record.capture.messageId) {
		throw new InvalidConversationCommandError("The target Message changed. Refresh the Prompt Plan before sending.");
	}
	const preparation = prepareGenerationInputs({
		database, conversationId, connection, formatting, kind: "sibling", messageId,
	});
	return {
		...preview.record.capture.capture,
		plan: acceptedEditedPlan(preview.record, preview.editedPlan, preparation),
	};
};
