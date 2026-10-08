import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import {
	budgetEditedPromptPlan,
	PromptBudgetExceededError,
	resolvePromptImages,
	type PromptPlan,
} from "../prompt-compiler";
import { promptImageResolutionFor } from "./prompt-image-resolution";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ModelClientConnectionSnapshot } from "../model-client";
import {
	captureGeneration,
	prepareGenerationInputsSnapshot,
	type CapturedGenerationFor,
	type GenerationCaptureOptions,
	type PrepareGenerationInputs,
} from "./generate-capture";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { promptPlan } from "../../shared/contract/conversation-schema";
import { InvalidConversationCommandError } from "../conversation";
import { estimateDynamicBlockTokens } from "../generation-plan";
import type {
	GenerationFormattingContext,
	GenerationTarget,
	GenerationTargetKind,
} from "../../shared/contract/conversation-schema";
import type { LoreActivationRecord } from "../../shared/contract/lore-activation";
import { memoryActivationWithFinalText, type MemoryActivationRecord } from "../../shared/contract/memory-recall";
import { processStateFor } from "../application/process-state";

export interface GenerationPreviewRecordFields {
	readonly id: string;
	readonly conversationId: number;
	readonly fingerprint: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

// @approved
//  The preview record retains the captured Generation of one attempt kind;
// the kind lives on the capture itself, riding the one Generation Target
// union.
export type GenerationPreviewRecordFor<K extends GenerationTargetKind> = GenerationPreviewRecordFields & {
	readonly capture: CapturedGenerationFor<K>;
};

export type GenerationPreviewRecord = GenerationPreviewRecordFor<GenerationTargetKind>;

export type GenerationPreviewAcceptanceFor<K extends GenerationTargetKind> = {
	readonly record: GenerationPreviewRecordFor<K>;
	readonly editedPlan: PromptPlan;
};

export type GenerationPreviewAcceptance = GenerationPreviewAcceptanceFor<GenerationTargetKind>;

/** ==[HUMAN APPROVED]== One preview request is one attempt target carrying its own capture
 * configuration, so the inspected Prompt Plan dispatches on the same union
 * the lifecycles do. */
export type GenerationPreviewRequest = GenerationCaptureOptions & GenerationTarget;

export const GENERATION_PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000;

export interface GenerationPreviewStore {
	previews: Map<number, GenerationPreviewRecord>;
	versions: Map<number, number>;
	/** Evicts preview records past their expiry; the process-state tick drives this while idle. */
	sweep(now?: number): void;
	dispose(): void;
}

// @approved
//  The expiring per-conversation inspection store. The process-state
// container owns its lifecycle; this factory owns only the store's behavior.
export const createGenerationPreviewStore = (): GenerationPreviewStore => {
	const previews = new Map<number, GenerationPreviewRecord>();
	const versions = new Map<number, number>();
	return {
		previews,
		versions,
		sweep: (now: number = Date.now()) => {
			for (const [conversationId, preview] of previews) if (preview.expiresAt <= now) previews.delete(conversationId);
		},
		dispose: () => { previews.clear(); versions.clear(); },
	};
};

const previewStore = (database: Database): GenerationPreviewStore => processStateFor(database).generationPreviews;

const ensureRecord = (database: Database, id: string, conversationId: number): GenerationPreviewRecord => {
	const store = previewStore(database);
	store.sweep();
	const record = store.previews.get(conversationId);
	if (record === undefined || record.id !== id) {
		throw new InvalidConversationCommandError(
			"The inspected Prompt Plan is unavailable. Refresh it after a server restart or when it has been abandoned.",
		);
	}
	return record;
};

export const previewRecordFor = <K extends GenerationTargetKind>(
	database: Database,
	id: string,
	conversationId: number,
	kind: K,
): GenerationPreviewRecordFor<K> => {
	const record = ensureRecord(database, id, conversationId);
	if (record.capture.kind !== kind) {
		throw new InvalidConversationCommandError("The Prompt Plan preview intent does not match this Generation.");
	}
	// @approved
	//  SAFETY: the capture's kind discriminant was just compared against the
	// caller's kind, so the record holds that kind's captured Generation.
	return record as GenerationPreviewRecordFor<K>;
};

export const consumeGenerationPreview = (
	database: Database,
	record: Pick<GenerationPreviewRecord, "id" | "conversationId">,
): void => {
	const { previews } = previewStore(database);
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
	const store = previewStore(database);
	store.sweep();
	const requestVersion = (store.versions.get(input.conversationId) ?? 0) + 1;
	store.versions.set(input.conversationId, requestVersion);
	const capture = await captureGeneration<GenerationTargetKind>(database, input, input);
	const now = Date.now();
	const record: GenerationPreviewRecord = {
		id: crypto.randomUUID(),
		conversationId: input.conversationId,
		fingerprint: capture.preparation.fingerprint,
		capture,
		createdAt: now,
		expiresAt: now + GENERATION_PREVIEW_SESSION_TTL_MS,
	};
	if (store.versions.get(record.conversationId) === requestVersion) store.previews.set(record.conversationId, record);
	return record;
};

const acceptedEditedPlan = (
	database: Database,
	record: GenerationPreviewRecord,
	submittedPlan: PromptPlan,
) => {
	if (!Value.Check(promptPlan, submittedPlan)) {
		throw new InvalidConversationCommandError("The edited Prompt Plan has invalid structure.");
	}
	assertEditedPlanStructure(record.capture.plan.promptPlan, submittedPlan);
	const settings = record.capture.plan.effectiveSettings;
	const editedPlan = resolvePromptImages(submittedPlan, promptImageResolutionFor(database, record.capture.connection, settings));
	if (JSON.stringify(editedPlan.intent ?? null) !== JSON.stringify(record.capture.plan.promptPlan.intent ?? null)) {
		throw new InvalidConversationCommandError("The Generation intent cannot be changed in an inspected Prompt Plan.");
	}
	const budget = budgetEditedPromptPlan({
		plan: editedPlan,
		contextLimit: settings.contextLimit,
		responseBudget: settings.responseBudget,
		safetyAllowance: settings.safetyAllowance,
	});
	if (!budget.fits) throw new PromptBudgetExceededError(budget);
	const sourceLore = record.capture.plan.loreActivation;
	const loreActivation = sourceLore === null
		? null
		: editedLoreActivation(sourceLore, editedPlan);
	const sourceMemory = record.capture.plan.memoryActivation;
	const editedMemoryBlock = editedPlan.blocks.find((block) => block.kind === "memory");
	if (sourceMemory !== null && editedMemoryBlock?.kind === "memory" &&
		estimateDynamicBlockTokens("memory", editedMemoryBlock.role, editedMemoryBlock.content) > sourceMemory.allowance) {
		throw new InvalidConversationCommandError("The edited Memory block exceeds this Chat's Memory Allowance.");
	}
	const memoryActivation = sourceMemory === null
		? null
		: editedMemoryActivation(sourceMemory, editedPlan);
	return { ...record.capture.plan, promptPlan: editedPlan, budget, loreActivation, memoryActivation };
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

const assertPreviewCurrent = (
	context: PreviewAcceptanceContext,
	fingerprint: string,
	target: GenerationTarget,
): void => {
	const input: PrepareGenerationInputs = {
		database: context.database,
		conversationId: context.conversationId,
		connection: context.connection,
		connectionSettings: context.connectionSettings,
		formatting: context.formatting,
		...target,
	};
	if (generationPreparationFingerprint(prepareGenerationInputsSnapshot(input)) !== fingerprint) {
		throw new InvalidConversationCommandError("The Prompt Plan is stale. Refresh it before sending.");
	}
};

const assertSubmittedTargetUnchanged = (
	recorded: GenerationTarget,
	submitted: GenerationTarget,
): void => {
	switch (recorded.kind) {
		case "send":
			if (submitted.kind !== "send" || recorded.content !== submitted.content) {
				throw new InvalidConversationCommandError("The submitted Human text changed. Refresh the Prompt Plan before sending.");
			}
			return;
		case "sibling":
			if (submitted.kind !== "sibling" || recorded.messageId !== submitted.messageId) {
				throw new InvalidConversationCommandError("The target Message changed. Refresh the Prompt Plan before sending.");
			}
			return;
		case "continuation":
			return;
	}
};

/** ==[HUMAN APPROVED]== Capture the accepted Generation from an inspected Prompt Plan: the
 * submitted attempt target must still match the recorded capture, the
 * preparation must still be current, and the retained capture returns with
 * the edited plan in place of the compiled one. */
export const captureGenerationPreview = (
	context: PreviewAcceptanceContext,
	preview: GenerationPreviewAcceptance,
	target: GenerationTarget,
): CapturedGenerationFor<GenerationTargetKind> => {
	const { record } = preview;
	ensureRecord(context.database, record.id, context.conversationId);
	assertSubmittedTargetUnchanged(record.capture, target);
	assertPreviewCurrent(context, record.fingerprint, target);
	return { ...record.capture, plan: acceptedEditedPlan(context.database, record, preview.editedPlan) };
};
