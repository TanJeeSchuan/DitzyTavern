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
import type { ModelFetch } from "../model-client/types";
import {
	captureContinuationGenerationAsync,
	captureSendGenerationAsync,
	captureSiblingGenerationAsync,
	prepareGenerationInputsSnapshot,
	type ContinuationGenerationCapture,
	type PrepareGenerationInputs,
	type SendGenerationCapture,
	type CapturedGeneration,
} from "./generate-capture";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { promptPlan } from "../../shared/contract/conversation-schema";
import { InvalidConversationCommandError } from "../conversation";
import { estimateDynamicBlockTokens } from "../generation-plan";
import type {
	GenerationFormattingContext,
	GenerationPreviewBody,
} from "../../shared/contract/conversation-schema";
import type { LoreActivationRecord } from "../../shared/contract/lore-activation";
import { memoryActivationWithFinalText, type MemoryActivationRecord } from "../../shared/contract/memory-recall";

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
	readonly preparationFetch?: ModelFetch;
	readonly tokenEstimator?: TokenEstimator;
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
		preparationFetch: request.preparationFetch,
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
// ==[HUMAN APPROVED]== A preview request reserves ownership before any semantic embedding work can suspend. The
// completion of an older request may still be returned to its caller, but it must never replace
// the inspected plan currently owned by this Conversation.
const previewRequestVersions = new Map<number, number>();
export const GENERATION_PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000;
const GENERATION_PREVIEW_SWEEP_INTERVAL_MS = 60 * 1000;

const beginPreviewRequest = (conversationId: number): number => {
	const version = (previewRequestVersions.get(conversationId) ?? 0) + 1;
	previewRequestVersions.set(conversationId, version);
	return version;
};

const ownsPreviewRequest = (conversationId: number, version: number): boolean =>
	previewRequestVersions.get(conversationId) === version;

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
	previewRequestVersions.clear();
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

/** ==[HUMAN APPROVED]== Asynchronous preview path used by the HTTP inspection route so semantic
 * activation is captured before the inspected plan is exposed. */
export const createGenerationPreviewAsync = async (
	database: Database,
	input: GenerationPreviewRequest,
): Promise<GenerationPreviewRecord> => {
	ensureScheduledPreviewSweep();
	sweepExpiredGenerationPreviews();
	const requestVersion = beginPreviewRequest(input.conversationId);
	const capture = await buildPreviewCaptureAsync(database, input);
	const now = Date.now();
	const record: GenerationPreviewRecord = {
		id: crypto.randomUUID(),
		conversationId: input.conversationId,
		fingerprint: capture.capture.preparation.fingerprint,
		capture,
		createdAt: now,
		expiresAt: now + GENERATION_PREVIEW_SESSION_TTL_MS,
	};
	if (ownsPreviewRequest(record.conversationId, requestVersion)) previews.set(record.conversationId, record);
	return record;
};

const acceptedEditedPlan = (
	record: GenerationPreviewRecord,
	editedPlan: PromptPlan,
) => {
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
	const sourceMemory = record.capture.capture.plan.memoryActivation;
	const editedMemoryBlock = editedPlan.blocks.find((block) => block.kind === "memory");
	if (sourceMemory !== null && editedMemoryBlock?.kind === "memory" &&
		estimateDynamicBlockTokens("memory", editedMemoryBlock.role, editedMemoryBlock.content) > sourceMemory.allowance) {
		throw new InvalidConversationCommandError("The edited Memory block exceeds this Chat's Memory Allowance.");
	}
	const memoryActivation = sourceMemory === null
		? null
		: editedMemoryActivation(sourceMemory, editedPlan);
	return { ...record.capture.capture.plan, promptPlan: editedPlan, budget, loreActivation, memoryActivation };
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

const editedMemoryActivation = (
	source: MemoryActivationRecord,
	plan: PromptPlan,
): MemoryActivationRecord => {
	const finalMemoryText = plan.blocks.find((block) => block.kind === "memory")?.content ?? "";
	return memoryActivationWithFinalText(source, finalMemoryText);
};

interface PreviewAcceptanceContext {
	readonly database: Database;
	readonly conversationId: number;
	readonly connection: ModelClientConnectionSnapshot | null | undefined;
	readonly connectionSettings: ConnectionSettingsModuleOptions | undefined;
	readonly formatting: GenerationFormattingContext | undefined;
}

type PreviewSnapshotKind =
	| { readonly kind: "send"; readonly content: string }
	| { readonly kind: "continuation" }
	| { readonly kind: "sibling"; readonly messageId: number };

const assertPreviewCurrent = (
	context: PreviewAcceptanceContext,
	record: GenerationPreviewRecord,
	kind: PreviewSnapshotKind,
): void => {
	const input: PrepareGenerationInputs = {
		database: context.database,
		conversationId: context.conversationId,
		connection: context.connection,
		connectionSettings: context.connectionSettings,
		formatting: context.formatting,
		...kind,
	};
	if (generationPreparationFingerprint(prepareGenerationInputsSnapshot(input)) !== record.fingerprint) {
		throw new InvalidConversationCommandError("The Prompt Plan is stale. Refresh it before sending.");
	}
};

export const captureSendGenerationPreview = (
	context: PreviewAcceptanceContext & {
		readonly preview: GenerationPreviewAcceptanceFor<"send">;
		readonly content: string;
	},
): SendGenerationCapture => {
	const { preview, content } = context;
	ensureRecord(preview.record.id, context.conversationId);
	if (content !== preview.record.capture.content) {
		throw new InvalidConversationCommandError("The submitted Human text changed. Refresh the Prompt Plan before sending.");
	}
	assertPreviewCurrent(context, preview.record, { kind: "send", content });
	const recorded = preview.record.capture.capture;
	return { ...recorded, plan: acceptedEditedPlan(preview.record, preview.editedPlan) };
};

export const captureContinuationGenerationPreview = (
	context: PreviewAcceptanceContext & {
		readonly preview: GenerationPreviewAcceptanceFor<"continuation">;
	},
): ContinuationGenerationCapture => {
	const { preview } = context;
	ensureRecord(preview.record.id, context.conversationId);
	assertPreviewCurrent(context, preview.record, { kind: "continuation" });
	const recorded = preview.record.capture.capture;
	const assistantPrefill = recorded.assistantPrefill === undefined
		? undefined
		: {
			...recorded.assistantPrefill,
			prefix: [...preview.editedPlan.blocks].reverse().find(
				(block) => block.kind === "history" && block.role === "model",
			)?.content ?? recorded.assistantPrefill.prefix,
		};
	return {
		...recorded,
		plan: acceptedEditedPlan(preview.record, preview.editedPlan),
		assistantPrefill,
	};
};

export const captureSiblingGenerationPreview = (
	context: PreviewAcceptanceContext & {
		readonly preview: GenerationPreviewAcceptanceFor<"sibling">;
		readonly messageId: number;
	},
): CapturedGeneration => {
	const { preview, messageId } = context;
	ensureRecord(preview.record.id, context.conversationId);
	if (messageId !== preview.record.capture.messageId) {
		throw new InvalidConversationCommandError("The target Message changed. Refresh the Prompt Plan before sending.");
	}
	assertPreviewCurrent(context, preview.record, { kind: "sibling", messageId });
	return { ...preview.record.capture.capture, plan: acceptedEditedPlan(preview.record, preview.editedPlan) };
};
