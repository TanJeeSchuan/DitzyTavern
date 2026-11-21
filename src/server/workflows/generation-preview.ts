import type { Database } from "bun:sqlite";
import { sameMoves } from "../../shared/contract/box-generation";
import { Value } from "@sinclair/typebox/value";
import {
	measurePromptPlan,
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
	type CapturedGeneration,
	type GenerationCaptureOptions,
	type PrepareGenerationInputs,
} from "./generate-capture";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { promptPlan } from "../../shared/contract/conversation-schema";
import { InvalidConversationCommandError } from "../conversation";
import type {
	GenerationFormattingContext,
	GenerationTarget,
} from "../../shared/contract/conversation-schema";
import type { LoreActivationRecord } from "../../shared/contract/lore-activation";
import type { BoxTraces } from "../../shared/contract/box-generation";
import { processStateFor } from "../application/process-state";

export interface GenerationPreviewRecord {
	readonly id: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly capture: CapturedGeneration;
}

export interface GenerationPreviewAcceptance {
	readonly record: GenerationPreviewRecord;
	readonly editedPlan: PromptPlan;
}

/** @approved One preview request is one attempt target carrying its own capture
 * configuration, so the inspected Prompt Plan dispatches on the same union
 * the lifecycles do. */
type GenerationPreviewRequest = GenerationCaptureOptions & { target: GenerationTarget };

export const GENERATION_PREVIEW_SESSION_TTL_MS = 60 * 60 * 1000;

export interface GenerationPreviewStore {
	previews: Map<number, GenerationPreviewRecord>;
	versions: Map<number, number>;
	/** @approved Evicts preview records past their expiry; the process-state tick drives this while idle. */
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

export const previewRecordFor = (database: Database, id: string, conversationId: number): GenerationPreviewRecord => {
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

export const consumeGenerationPreview = (
	database: Database,
	record: Pick<GenerationPreviewRecord, "id" | "capture">,
): void => {
	const { previews } = previewStore(database);
	const { conversationId } = record.capture.preparation;
	if (previews.get(conversationId)?.id === record.id) previews.delete(conversationId);
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

/** @approved Asynchronous preview path used by the HTTP inspection route so semantic
 * activation is captured before the inspected plan is exposed. */
export const createGenerationPreviewAsync = async (
	database: Database,
	input: GenerationPreviewRequest,
): Promise<GenerationPreviewRecord> => {
	const store = previewStore(database);
	store.sweep();
	const { conversationId } = input;
	const requestVersion = (store.versions.get(conversationId) ?? 0) + 1;
	store.versions.set(conversationId, requestVersion);
	const capture = await captureGeneration(database, input.target, input);
	const now = Date.now();
	const record: GenerationPreviewRecord = {
		id: crypto.randomUUID(),
		capture,
		createdAt: now,
		expiresAt: now + GENERATION_PREVIEW_SESSION_TTL_MS,
	};
	if (store.versions.get(conversationId) === requestVersion) store.previews.set(conversationId, record);
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
	const editedPlan = resolvePromptImages(submittedPlan, promptImageResolutionFor(database, record.capture.preparation.connection, settings));
	if (JSON.stringify(editedPlan.intent ?? null) !== JSON.stringify(record.capture.plan.promptPlan.intent ?? null)) {
		throw new InvalidConversationCommandError("The Generation intent cannot be changed in an inspected Prompt Plan.");
	}
	const { contextLimit, responseBudget, safetyAllowance } = settings;
	const budget = measurePromptPlan({ plan: editedPlan, contextLimit, responseBudget, safetyAllowance });
	if (!budget.fits) throw new PromptBudgetExceededError(budget);
	const sourceLore = record.capture.plan.loreActivation;
	const loreActivation = sourceLore === null
		? null
		: editedLoreActivation(sourceLore, editedPlan);
	return { ...record.capture.plan, promptPlan: editedPlan, budget, loreActivation, boxTraces: editedBoxTraces(record.capture.plan.boxTraces, editedPlan) };
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

// @approved
//  Each Box's block as sent. A Box's allowance governs only its automatic
// admission; the writer's edit answers to the plan's context budget alone.
const editedBoxTraces = (source: BoxTraces, plan: PromptPlan): BoxTraces => Object.fromEntries(Object.entries(source).map(([reference, trace]) =>
	[reference, { ...trace, finalText: plan.blocks.find((block) => block.kind === reference)?.content ?? "" }]));

interface PreviewAcceptanceContext {
	readonly database: Database;
	readonly conversationId: number;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions | undefined;
	readonly formatting?: GenerationFormattingContext | undefined;
}

const assertPreviewCurrent = (
	context: PreviewAcceptanceContext,
	fingerprint: string,
	target: GenerationTarget,
	seed: string,
): void => {
	const input: PrepareGenerationInputs = {
		database: context.database,
		conversationId: context.conversationId,
		connection: context.connection,
		connectionSettings: context.connectionSettings,
		formatting: context.formatting,
		target, seed,
	};
	if (generationPreparationFingerprint(prepareGenerationInputsSnapshot(input)) !== fingerprint) {
		throw new InvalidConversationCommandError("The Prompt Plan is stale. Refresh it before sending.");
	}
};

const sameGenerationTarget = (recorded: GenerationTarget, submitted: GenerationTarget): boolean => {
	switch (recorded.kind) {
		case "send": return submitted.kind === "send" && recorded.content === submitted.content && sameMoves(recorded.moves, submitted.moves);
		case "continuation": return submitted.kind === "continuation";
		case "sibling": return submitted.kind === "sibling" && recorded.messageId === submitted.messageId && Boolean(recorded.reroll) === Boolean(submitted.reroll);
	}
};

/** @approved Capture the accepted Generation from an inspected Prompt Plan: the
 * submitted attempt target must still match the recorded capture, the
 * preparation must still be current, and the retained capture returns with
 * the edited plan in place of the compiled one. */
export const captureGenerationPreview = (
	context: PreviewAcceptanceContext,
	preview: GenerationPreviewAcceptance,
	target: GenerationTarget,
): CapturedGeneration => {
	const { record } = preview;
	const { preparation } = record.capture;
	previewRecordFor(context.database, record.id, context.conversationId);
	if (!sameGenerationTarget(preparation.target, target)) {
		throw new InvalidConversationCommandError("The submitted Generation target changed. Refresh the Prompt Plan before sending.");
	}
	assertPreviewCurrent(context, preparation.fingerprint, target, preparation.seed);
	return { ...record.capture, plan: acceptedEditedPlan(context.database, record, preview.editedPlan) };
};
