import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import {
	budgetEditedPromptPlan,
	PromptBudgetExceededError,
	resolvePromptImages,
	type PromptPlan,
	type TokenEstimator,
} from "../prompt-compiler";
import { imageLookup, type ImagePool } from "../image";
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

type WithoutFormatting<T> = T extends unknown ? Omit<T, "timeZone" | "locale" | "images"> : never;

export type GenerationPreviewRequest = WithoutFormatting<GenerationPreviewBody> & {
	readonly conversationId: number;
	readonly formatting?: GenerationFormattingContext;
	readonly connection?: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions;
	readonly preparationFetch?: ModelFetch;
	readonly tokenEstimator?: TokenEstimator;
	readonly images?: ImagePool | undefined;
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
		images: request.images,
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

export const GENERATION_PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000;
const stores = new WeakMap<Database, ReturnType<typeof createPreviewStore>>();

const createPreviewStore = () => {
	const previews = new Map<number, GenerationPreviewRecord>();
	const versions = new Map<number, number>();
	const sweep = () => {
		for (const [id, preview] of previews) if (preview.expiresAt <= Date.now()) previews.delete(id);
	};
	const timer = setInterval(sweep, 60_000);
	timer.unref();
	return {
		previews,
		versions,
		sweep,
		dispose: () => { clearInterval(timer); previews.clear(); versions.clear(); },
	};
};

const previewStore = (database: Database) => {
	let store = stores.get(database);
	if (store === undefined) { store = createPreviewStore(); stores.set(database, store); }
	return store;
};

/** Dispose and forget this database's preview store; no-op if it never created one. */
export const clearGenerationPreviewRegistry = (database: Database): void => {
	stores.get(database)?.dispose();
	stores.delete(database);
};

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

const isPreviewRecordFor = <K extends GenerationPreviewKind>(
	record: GenerationPreviewRecord,
	kind: K,
): record is GenerationPreviewRecordFor<K> => record.capture.kind === kind;

export const previewRecordFor = <K extends GenerationPreviewKind>(
	database: Database,
	id: string,
	conversationId: number,
	kind: K,
): GenerationPreviewRecordFor<K> => {
	const record = ensureRecord(database, id, conversationId);
	if (!isPreviewRecordFor(record, kind)) {
		throw new InvalidConversationCommandError("The Prompt Plan preview intent does not match this Generation.");
	}
	return record;
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
	if (store.versions.get(record.conversationId) === requestVersion) store.previews.set(record.conversationId, record);
	return record;
};

const acceptedEditedPlan = (
	database: Database,
	record: GenerationPreviewRecord,
	submittedPlan: PromptPlan,
	images: ImagePool | undefined,
) => {
	if (!Value.Check(promptPlan, submittedPlan)) {
		throw new InvalidConversationCommandError("The edited Prompt Plan has invalid structure.");
	}
	assertEditedPlanStructure(record.capture.capture.plan.promptPlan, submittedPlan);
	const settings = record.capture.capture.plan.effectiveSettings;
	const editedPlan = resolvePromptImages(submittedPlan, {
		lookup: imageLookup(database, images),
		placement: settings.repeatedImagePlacement,
	});
	if (JSON.stringify(editedPlan.intent ?? null) !== JSON.stringify(record.capture.capture.plan.promptPlan.intent ?? null)) {
		throw new InvalidConversationCommandError("The Generation intent cannot be changed in an inspected Prompt Plan.");
	}
	const budget = budgetEditedPromptPlan({
		plan: editedPlan,
		contextLimit: settings.contextLimit,
		responseBudget: settings.responseBudget,
		safetyAllowance: settings.safetyAllowance,
		includeImageTokens: record.capture.capture.connection?.textOnlyModels.includes(settings.modelId) !== true,
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
	readonly images: ImagePool | undefined;
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
	ensureRecord(context.database, preview.record.id, context.conversationId);
	if (content !== preview.record.capture.content) {
		throw new InvalidConversationCommandError("The submitted Human text changed. Refresh the Prompt Plan before sending.");
	}
	assertPreviewCurrent(context, preview.record, { kind: "send", content });
	const recorded = preview.record.capture.capture;
	return { ...recorded, plan: acceptedEditedPlan(context.database, preview.record, preview.editedPlan, context.images) };
};

export const captureContinuationGenerationPreview = (
	context: PreviewAcceptanceContext & {
		readonly preview: GenerationPreviewAcceptanceFor<"continuation">;
	},
): ContinuationGenerationCapture => {
	const { preview } = context;
	ensureRecord(context.database, preview.record.id, context.conversationId);
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
		plan: acceptedEditedPlan(context.database, preview.record, preview.editedPlan, context.images),
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
	ensureRecord(context.database, preview.record.id, context.conversationId);
	if (messageId !== preview.record.capture.messageId) {
		throw new InvalidConversationCommandError("The target Message changed. Refresh the Prompt Plan before sending.");
	}
	assertPreviewCurrent(context, preview.record, { kind: "sibling", messageId });
	return { ...preview.record.capture.capture, plan: acceptedEditedPlan(context.database, preview.record, preview.editedPlan, context.images) };
};
