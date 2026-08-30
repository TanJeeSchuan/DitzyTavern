import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { activeGenerationTable } from "../database/schema";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	ContinuationUnavailableError,
	deriveMessageSwipeEligibility,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	type ConversationDataEntry,
	type ConversationJsonValue,
	type ConversationSnapshot,
} from "../conversation";
import type { ConversationGenerationSettings } from "../conversation";
import type { CastParticipantSnapshot } from "../conversation/types";
import {
	assertPromptBudget,
	budgetPromptPlan,
	compilePrompt,
	type PromptBudgetResult,
	type PromptHistoryEntry,
	type PromptPlan,
	type GenerationIntent,
	type TokenEstimator,
} from "../prompt-compiler";
import {
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../connection-settings";
import {
	type AssistantPrefill,
	type ModelClientConnectionSnapshot,
	type ModelClientGenerationSettings,
} from "../model-client";
import {
	generationProvenanceCodec,
	type GenerationProvenanceRecord,
} from "../../shared/generation-provenance";

// Generation-start capture: from one authoritative Conversation snapshot this
// module derives the provider-neutral Prompt Plan, the budgeted plan, the
// captured participants and Control pair, and the settings/connection/
// provenance records that every server-owned Generation persists at start.
// The workflow entry points consume these captures; nothing here contacts a
// transport or mutates Conversation state.

export interface ParticipantPreview {
	id: number;
	name: string;
}

interface GenerationDerivation {
	plan: PromptPlan;
	history: readonly PromptHistoryEntry[];
	historyRoles: readonly ("human" | "model" | null)[];
	humanParticipant: ParticipantPreview;
	modelParticipant: ParticipantPreview;
	compile: (history: readonly PromptHistoryEntry[]) => PromptPlan;
	protectedHistoryIndex?: number;
}

interface SelectedHistory {
	entries: readonly PromptHistoryEntry[];
	roles: readonly ("human" | "model" | null)[];
}

// Selected-history entries for prompt compilation, derived from each
// Message's selected Variant and its immutable Author Stamp name.
// `endExclusiveIndex` limits the entries to Messages strictly preceding a
// targeted sibling Variant; omitted, the entire ordered snapshot counts, as
// a Tail Generation uses.
const selectedHistoryFrom = (
	snapshot: ConversationSnapshot,
	humanParticipantId: number,
	modelParticipantId: number,
	endExclusiveIndex?: number,
	roleForMessage: (
		message: ConversationSnapshot["messages"][number],
	) => "human" | "model" | null = (message) =>
		message.author?.participantId === humanParticipantId
			? "human"
			: message.author?.participantId === modelParticipantId
				? "model"
				: null,
): SelectedHistory => {
	const entries: PromptHistoryEntry[] = [];
	const roles: ("human" | "model" | null)[] = [];

	for (const message of snapshot.messages.slice(0, endExclusiveIndex)) {
		const selected = message.variants.find((variant) => variant.selected);
		if (selected === undefined) continue;

		entries.push({
			speakerName: message.author?.capturedName ?? null,
			content: selected.content,
		});
		roles.push(roleForMessage(message));
	}

	return { entries, roles };
};

export const deriveGeneration = (
	snapshot: ConversationSnapshot,
): GenerationDerivation | null => {
	const human = snapshot.cast.find(
		(participant) => participant.id === snapshot.control.humanParticipantId,
	);
	const model = snapshot.cast.find(
		(participant) => participant.id === snapshot.control.modelParticipantId,
	);
	if (human === undefined || model === undefined || human.id === model.id) {
		return null;
	}

	const selectedHistory = selectedHistoryFrom(snapshot, human.id, model.id);
	const compile = (history: readonly PromptHistoryEntry[]) => compilePrompt({
		human: toCompilerDefinition(human),
		model: toCompilerDefinition(model),
		history,
	});
	const plan = compile(selectedHistory.entries);

	return {
		plan,
		history: selectedHistory.entries,
		historyRoles: selectedHistory.roles,
		humanParticipant: { id: human.id, name: human.name },
		modelParticipant: { id: model.id, name: model.name },
		compile,
	};
};

const toCompilerDefinition = (participant: CastParticipantSnapshot) => ({
	name: participant.name,
	prompt: {
		systemInstruction: participant.prompt.systemInstruction,
		identity: participant.prompt.identity,
		scenario: participant.prompt.scenario,
		exampleDialogue: participant.prompt.exampleDialogue,
		postHistoryInstruction: participant.prompt.postHistoryInstruction,
	},
});

export interface GenerationSettingsCapture {
	settings: ConversationGenerationSettings;
	connection: ModelClientConnectionSnapshot | null;
	provenance: ConversationDataEntry;
}

function captureGenerationSettings(
	database: Database,
	conversationId: number,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
): GenerationSettingsCapture {
	const conversation = createConversationModule(database);
	const settings = conversation.getGenerationSettings(conversationId);
	if (settings === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	const capturedConnection = connection === undefined
		? resolveConnectionSnapshot(database, connectionSettingsOptions)
		: connection;
	const provenanceRecord: GenerationProvenanceRecord = {
		connectionProfileId: capturedConnection?.profileId ?? null,
		connectionSettingsRevision: capturedConnection?.settingsRevision ?? null,
		modelBackend: capturedConnection?.backend ?? null,
		adapter: capturedConnection?.adapter ?? null,
		modelId: settings.modelId,
		generationSettings: {
			temperature: settings.temperature,
			topP: settings.topP,
			frequencyPenalty: settings.frequencyPenalty,
			presencePenalty: settings.presencePenalty,
			contextLimit: settings.contextLimit,
			responseBudget: settings.responseBudget,
			safetyAllowance: settings.safetyAllowance,
			siblingGenerationLimit: settings.siblingGenerationLimit,
			continuationStrategy: settings.continuationStrategy,
			continuationInstruction: settings.continuationInstruction,
			continuationPrefillSuffix: settings.continuationPrefillSuffix,
		},
		usage: null,
		finishReason: null,
		status: null,
		interruptionCause: null,
	};
	const provenance = {
		namespace: "generation",
		key: "provenance",
		value: generationProvenanceCodec.encode(provenanceRecord),
	} satisfies ConversationDataEntry;
	return { settings, connection: capturedConnection, provenance };
}

interface CapturedGeneration {
	readonly promptPlan: PromptPlan;
	readonly budget: PromptBudgetResult;
	readonly historyRoles: readonly ("human" | "model" | null)[];
	readonly humanParticipant: ParticipantPreview;
	readonly author: {
		readonly participantId: number;
		readonly capturedName: string;
	};
	readonly control: {
		readonly humanParticipantId: number;
		readonly modelParticipantId: number;
	};
	readonly settings: ConversationGenerationSettings;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly provenance: ConversationDataEntry;
}

/**
 * Assemble the shared Generation-start capture every lifecycle builds: the
 * budgeted plan, the retained history roles, the Control pair, the model
 * author stamp, and the settings/connection/provenance captures.
 */
const toCapturedGeneration = (
	derivation: GenerationDerivation,
	settingsCapture: GenerationSettingsCapture,
	budget: PromptBudgetResult,
): CapturedGeneration => ({
	promptPlan: budget.plan,
	budget,
	historyRoles: budget.retainedHistoryRoles,
	humanParticipant: derivation.humanParticipant,
	author: {
		participantId: derivation.modelParticipant.id,
		capturedName: derivation.modelParticipant.name,
	},
	control: {
		humanParticipantId: derivation.humanParticipant.id,
		modelParticipantId: derivation.modelParticipant.id,
	},
	settings: settingsCapture.settings,
	connection: settingsCapture.connection,
	provenance: settingsCapture.provenance,
});

function resolveConnectionSnapshot(
	database: Database,
	options: ConnectionSettingsModuleOptions | undefined,
): ModelClientConnectionSnapshot | null {
	const settings = createConnectionSettingsModule(database, options).get();
	if (settings.activeProfileId === null) return null;
	const profile = settings.profiles.find(
		(entry) => entry.id === settings.activeProfileId,
	);
	if (profile === undefined) return null;
	return {
		profileId: profile.id,
		settingsRevision: settings.revision,
		backend: "ai-sdk",
		adapter: profile.adapter,
	};
}

export const toModelClientGenerationSettings = (
	settings: ConversationGenerationSettings,
): ModelClientGenerationSettings => ({
	temperature: settings.temperature,
	topP: settings.topP,
	frequencyPenalty: settings.frequencyPenalty,
	presencePenalty: settings.presencePenalty,
	contextLimit: settings.contextLimit,
	responseBudget: settings.responseBudget,
	requestOverrides: settings.requestOverrides,
});

export function createBudgetedPlan(
	derivation: GenerationDerivation,
	settings: ConversationGenerationSettings,
	estimator?: TokenEstimator,
): PromptBudgetResult {
	return budgetPromptPlan({
		plan: derivation.plan,
		compile: derivation.compile,
		history: derivation.history,
		historyRoles: derivation.historyRoles,
		contextLimit: settings.contextLimit,
		responseBudget: settings.responseBudget,
		safetyAllowance: settings.safetyAllowance,
		estimator,
		protectedHistoryIndex: derivation.protectedHistoryIndex,
	});
}

// Active Generation persistence stores only a closed JSON projection of the
// provider-neutral captures. These explicit projections keep provider and
// class instances out of the Conversation domain boundary.
export const promptPlanJson = (plan: PromptPlan): ConversationJsonValue => {
	const result = {
		blocks: plan.blocks.map((block): ConversationJsonValue => block.kind === "identity"
			? { kind: block.kind, role: block.role, content: block.content }
			: block.kind === "history"
				? { kind: block.kind, speakerName: block.speakerName, content: block.content }
				: { kind: block.kind, content: block.content }),
		warnings: plan.warnings.map((warning) => ({
			block: warning.block,
			macro: warning.macro,
		})),
	} satisfies ConversationJsonValue;
	return plan.intent === undefined ? result : { ...result, intent: plan.intent };
};

export const generationSettingsJson = (
	settings: ModelClientGenerationSettings & {
		readonly modelId?: string;
		readonly siblingGenerationLimit?: number;
		readonly continuationStrategy?: string | null;
		readonly continuationInstruction?: string | null;
		readonly continuationPrefillSuffix?: string | null;
	},
): ConversationJsonValue => ({
	modelId: settings.modelId ?? null,
	siblingGenerationLimit: settings.siblingGenerationLimit ?? null,
	temperature: settings.temperature,
	topP: settings.topP,
	frequencyPenalty: settings.frequencyPenalty,
	presencePenalty: settings.presencePenalty,
	contextLimit: settings.contextLimit,
	responseBudget: settings.responseBudget,
	continuationStrategy: settings.continuationStrategy ?? null,
	continuationInstruction: settings.continuationInstruction ?? null,
	continuationPrefillSuffix: settings.continuationPrefillSuffix ?? null,
	requestOverrides: settings.requestOverrides,
});

export const connectionJson = (
	connection: ModelClientConnectionSnapshot | null,
): ConversationJsonValue => connection === null
	? null
	: {
			profileId: connection.profileId,
			settingsRevision: connection.settingsRevision,
			backend: connection.backend,
			adapter: connection.adapter,
		};

// Active inspection keeps the exact budget decision made at Generation
// start, including the whole history entries omitted during preflight. It is
// deliberately not copied into terminal Variant provenance.
export const promptInspectionJson = (budget: PromptBudgetResult): ConversationJsonValue => ({
	tokenEstimate: budget.tokenEstimate,
	responseBudget: budget.responseBudget,
	safetyAllowance: budget.safetyAllowance,
	contextLimit: budget.contextLimit,
	totalRequiredTokens: budget.totalRequiredTokens,
	omittedHistory: budget.omittedHistory.map((entry) => ({
		speakerName: entry.speakerName,
		content: entry.content,
	})),
});

export interface SendGenerationCapture extends CapturedGeneration {
	humanContent: string;
	reuseHumanMessageId: number | undefined;
}

// Build the candidate Prompt Plan without writing it. A retry reuses the
// already accepted trailing human Message; a fresh Send appends the submitted
// human writing to the selected narrative path before budgeting.
export function captureSendGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	content: string,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
	tokenEstimator: TokenEstimator | undefined,
): SendGenerationCapture {
	const settingsCapture = captureGenerationSettings(
		database,
		snapshot.id,
		connection,
		connectionSettingsOptions,
	);
	const derivation = deriveGeneration(snapshot);
	if (derivation === null) throw new ConversationNotPlayableError(snapshot.id);

	const latest = snapshot.messages.at(-1);
	const latestSelected = latest?.variants.find((variant) => variant.selected);
	const reuseHumanMessageId = latest !== undefined &&
		latest.author?.participantId === derivation.humanParticipant.id &&
		latestSelected?.content === content
		? latest.id
		: undefined;
	const history = reuseHumanMessageId === undefined
		? [...derivation.history, {
			speakerName: derivation.humanParticipant.name,
			content,
		}]
		: derivation.history;
	const historyRoles = reuseHumanMessageId === undefined
		? [...derivation.historyRoles, "human" as const]
		: derivation.historyRoles;
	const plan = derivation.compile(history);
	const candidate: GenerationDerivation = {
		...derivation,
		plan,
		history,
		historyRoles,
	};
	const budget = assertPromptBudget(
		createBudgetedPlan(candidate, settingsCapture.settings, tokenEstimator),
	);
	return {
		...toCapturedGeneration(derivation, settingsCapture, budget),
		humanContent: content,
		reuseHumanMessageId,
	};
}

export interface ContinuationGenerationCapture extends CapturedGeneration {
	precedingMessageId: number;
	precedingVariantId: number;
	intent: GenerationIntent;
	assistantPrefill?: AssistantPrefill;
}

const isActiveGeneration = (database: Database, conversationId: number): boolean =>
	drizzle(database)
		.select({ id: activeGenerationTable.id })
		.from(activeGenerationTable)
		.where(eq(activeGenerationTable.chat_id, conversationId))
		.get() !== undefined;

function continuationHasUsableOutput(
	variant: ConversationSnapshot["messages"][number]["variants"][number],
): boolean {
	if (variant.content.length > 0) return true;
	return variant.data.some(
		(entry) => entry.namespace === "generation" &&
			entry.key === "reasoning" &&
			entry.value.length > 0,
	);
}

export function captureContinuationGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
	tokenEstimator: TokenEstimator | undefined,
): ContinuationGenerationCapture {
	if (isActiveGeneration(database, snapshot.id)) {
		throw new ContinuationUnavailableError("active-generation");
	}
	if (!snapshot.playable) throw new ConversationNotPlayableError(snapshot.id);
	const latest = snapshot.messages.at(-1);
	const selected = latest?.variants.find((variant) => variant.selected);
	const modelParticipantId = snapshot.control.modelParticipantId;
	const latestWasModelAuthored = latest?.author?.participantId !== null &&
		latest?.author?.participantId !== undefined &&
		(modelParticipantId === latest.author.participantId ||
			latest.historicalContext?.modelParticipantId === latest.author.participantId);
	if (
		latest === undefined ||
		selected === undefined ||
		modelParticipantId === null ||
		!latestWasModelAuthored ||
		!continuationHasUsableOutput(selected)
	) {
		throw new ContinuationUnavailableError("not-terminal-model-message");
	}
	const derivation = deriveGeneration(snapshot);
	if (derivation === null) throw new ConversationNotPlayableError(snapshot.id);
	const settingsCapture = captureGenerationSettings(
		database,
		snapshot.id,
		connection,
		connectionSettingsOptions,
	);
	if (settingsCapture.settings.continuationStrategy !== "instruction") {
		if (selected.content.length === 0) {
			throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
		}
	}
	const intent: GenerationIntent = settingsCapture.settings.continuationStrategy === "instruction"
		? {
			type: "continuation",
			strategy: "instruction",
			instruction: settingsCapture.settings.continuationInstruction,
		}
		: {
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: settingsCapture.settings.continuationPrefillSuffix,
		};
	const compile = (history: readonly PromptHistoryEntry[]) => ({
		...derivation.compile(history),
		intent,
	});
	// A prior model Message can have been authored by the Participant who held
	// model Control at that time. Preserve that role in the continuation's
	// provider input even when the current model Control has moved on.
	const continuationHistory = selectedHistoryFrom(
		snapshot,
		derivation.humanParticipant.id,
		derivation.modelParticipant.id,
		undefined,
		(message) => {
			const authorId = message.author?.participantId;
			if (
				message.historicalContext?.modelParticipantId === authorId ||
				authorId === derivation.modelParticipant.id
			) {
				return "model";
			}
			if (
				message.historicalContext?.humanParticipantId === authorId ||
				authorId === derivation.humanParticipant.id
			) {
				return "human";
			}
			return null;
		},
	);
	const continuationDerivation: GenerationDerivation = {
		...derivation,
		historyRoles: continuationHistory.roles,
		plan: compile(derivation.history),
		compile,
		protectedHistoryIndex: settingsCapture.settings.continuationStrategy === "assistant-prefill"
			? continuationHistory.entries.length - 1
			: undefined,
	};
	const budget = assertPromptBudget(
		createBudgetedPlan(continuationDerivation, settingsCapture.settings, tokenEstimator),
	);
	return {
		...toCapturedGeneration(continuationDerivation, settingsCapture, budget),
		precedingMessageId: latest.id,
		precedingVariantId: selected.id,
		intent,
		assistantPrefill: settingsCapture.settings.continuationStrategy === "assistant-prefill"
			? {
				prefix: selected.content,
				suffix: settingsCapture.settings.continuationPrefillSuffix,
			}
			: undefined,
	};
}

const deriveSiblingDerivation = (
	snapshot: ConversationSnapshot,
	messageId: number,
) => {
	const targetIndex = snapshot.messages.findIndex(
		(message) => message.id === messageId,
	);
	const target = targetIndex === -1 ? undefined : snapshot.messages[targetIndex];
	if (target === undefined) {
		throw new InvalidConversationCommandError(
			`Message ${messageId} does not belong to Conversation ${snapshot.id}.`,
		);
	}

	// Same derived rule as the snapshot exposes: playable Conversation,
	// captured historical pair, and both historical Participants still in
	// the Cast with usable Definitions.
	const eligibility = deriveMessageSwipeEligibility(
		snapshot.playable,
		target.historicalContext,
		snapshot.cast.map((participant) => participant.id),
	);
	if (!eligibility.eligible) {
		if (eligibility.reason === "conversation-not-playable") {
			throw new ConversationNotPlayableError(snapshot.id);
		}
		// The discriminated eligibility narrows the remaining reasons to the
		// two historical denials; no fallback reason is ever fabricated.
		throw new SiblingVariantUnavailableError(eligibility.reason);
	}

	const context = target.historicalContext;
	if (context === null) {
		// Unreachable after the eligibility check; keeps the pair trusted.
		throw new SiblingVariantUnavailableError("missing-historical-context");
	}
	const human = snapshot.cast.find(
		(participant) => participant.id === context.humanParticipantId,
	);
	const model = snapshot.cast.find(
		(participant) => participant.id === context.modelParticipantId,
	);
	if (human === undefined || model === undefined) {
		throw new SiblingVariantUnavailableError(
			"historical-participant-unavailable",
		);
	}

	// Selected history strictly preceding the target Message. Excluding the
	// target by construction also excludes all of its existing sibling
	// Variants: an alternative never prompts on another alternative.
	const selectedHistory = selectedHistoryFrom(
		snapshot,
		human.id,
		model.id,
		targetIndex,
	);

	// The historical pair's current Definitions and names, so a rename or
	// Prompt edit before this generation starts contributes; the Message
	// itself keeps displaying its captured author name.
	const compile = (history: readonly PromptHistoryEntry[]) => compilePrompt({
		human: toCompilerDefinition(human),
		model: toCompilerDefinition(model),
		history,
	});
	const plan = compile(selectedHistory.entries);

	return {
		plan,
		history: selectedHistory.entries,
		historyRoles: selectedHistory.roles,
		humanParticipant: { id: human.id, name: human.name },
		modelParticipant: { id: model.id, name: model.name },
		compile,
	};
};

export interface SiblingGenerationCapture extends CapturedGeneration {
	readonly priorVariantId: number | null;
}

export function captureSiblingGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	input: {
		messageId: number;
		connection?: ModelClientConnectionSnapshot | null | undefined;
		connectionSettings?: ConnectionSettingsModuleOptions | undefined;
		tokenEstimator?: TokenEstimator | undefined;
	},
): SiblingGenerationCapture {
	const derivation = deriveSiblingDerivation(snapshot, input.messageId);
	const settingsCapture = captureGenerationSettings(
		database,
		snapshot.id,
		input.connection,
		input.connectionSettings,
	);
	const siblingDerivation: GenerationDerivation = {
		...derivation,
		plan: { ...derivation.plan, intent: { type: "sibling" } },
	};
	const budget = assertPromptBudget(
		createBudgetedPlan(siblingDerivation, settingsCapture.settings, input.tokenEstimator),
	);
	const target = snapshot.messages.find((message) => message.id === input.messageId);
	const priorVariantId = target?.variants.find((variant) => variant.selected)?.id ?? null;
	return {
		...toCapturedGeneration(siblingDerivation, settingsCapture, budget),
		priorVariantId,
	};
}
