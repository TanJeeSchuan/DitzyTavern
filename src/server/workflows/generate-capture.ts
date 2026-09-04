import type { Database } from "bun:sqlite";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	ContinuationUnavailableError,
	deriveMessageSwipeEligibility,
	hasActiveGeneration,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	type AcceptTailGenerationInput,
	type ConversationDataEntry,
	type ConversationJsonValue,
	type ConversationSnapshot,
} from "../conversation";
import type { ConversationGenerationSettings } from "../conversation";
import type { CastParticipantSnapshot } from "../conversation/types";
import {
	assertGenerationPlan,
	compileGenerationPlan,
	continuationIntentFor,
	type EffectiveGenerationSettings,
	type GenerationConnectionFacts,
	type GenerationPlan,
} from "../generation-plan";
import type {
	GenerationIntent,
	PromptBudgetResult,
	PromptHistoryEntry,
	PromptPlan,
	TokenEstimator,
} from "../prompt-compiler";
import {
	connectionSnapshotOf,
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../connection-settings";
import {
	type AssistantPrefill,
	type ModelClientGenerationInput,
	type ModelClientConnectionSnapshot,
} from "../model-client";
import { projectModelClientGenerationSettings } from "../model-client";
import type { GenerationAttemptInput } from "./generate-server-owned";
import {
	generationProvenanceCodec,
	type GenerationProvenanceRecord,
	type GenerationProvenanceSettings,
} from "../../shared/generation-provenance";
import { type GenerationSettingsField } from "../../shared/contract/generation-settings";

// ==[HUMAN APPROVED]== Generation-start capture: from one authoritative Conversation snapshot and
// the captured configuration this module derives the complete Generation Plan
// through the one Generation Plan Compiler, together with the captured
// participants and Control pair and the provenance record every server-owned
// Generation persists at start. The workflow entry points consume these
// captures; nothing here contacts a transport or mutates Conversation state.

export interface ParticipantPreview {
	id: number;
	name: string;
}

interface GenerationDerivation {
	human: CastParticipantSnapshot;
	model: CastParticipantSnapshot;
	history: readonly PromptHistoryEntry[];
	historyRoles: readonly ("human" | "model" | null)[];
}

interface SelectedHistory {
	entries: readonly PromptHistoryEntry[];
	roles: readonly ("human" | "model" | null)[];
}

// ==[HUMAN APPROVED]== Selected-history entries for prompt compilation, derived from each
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

	return {
		human,
		model,
		history: selectedHistory.entries,
		historyRoles: selectedHistory.roles,
	};
};

export const toCompilerDefinition = (participant: CastParticipantSnapshot) => ({
	name: participant.name,
	prompt: {
		systemInstruction: participant.prompt.systemInstruction,
		identity: participant.prompt.identity,
		scenario: participant.prompt.scenario,
		exampleDialogue: participant.prompt.exampleDialogue,
		postHistoryInstruction: participant.prompt.postHistoryInstruction,
	},
});

// ==[HUMAN APPROVED]== Safe Connection resolution for inspection: the active Profile's API Format
// fact only, resolved before compilation so Request Overrides narrow exactly
// as an executed attempt would narrow them.
export const resolveConnectionApiFormat = (
	database: Database,
	options: ConnectionSettingsModuleOptions | undefined,
): GenerationConnectionFacts | null => {
	const connection = resolveConnectionSnapshot(database, options);
	return connection === null ? null : { apiFormat: connection.apiFormat };
};

interface AttemptConfiguration {
	settings: ConversationGenerationSettings;
	connection: ModelClientConnectionSnapshot | null;
}

function captureConfiguration(
	database: Database,
	conversationId: number,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
): AttemptConfiguration {
	const conversation = createConversationModule(database);
	const settings = conversation.getGenerationSettings(conversationId);
	if (settings === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	const capturedConnection = connection === undefined
		? resolveConnectionSnapshot(database, connectionSettingsOptions)
		: connection;
	return { settings, connection: capturedConnection };
}

// ==[HUMAN APPROVED]== The retained provenance record: safe connection identity, model identity,
// and the attempt's Effective Generation Settings. Only fields in the shared
// provenance vocabulary are retained — an intent-inapplicable Continuation
// operand is already absent from the plan — and Request Overrides are never
// retained.
const generationProvenanceEntry = (
	plan: GenerationPlan,
	connection: ModelClientConnectionSnapshot | null,
): ConversationDataEntry => {
	const generationSettings = {
		temperature: plan.effectiveSettings.temperature,
		topP: plan.effectiveSettings.topP,
		frequencyPenalty: plan.effectiveSettings.frequencyPenalty,
		presencePenalty: plan.effectiveSettings.presencePenalty,
		contextLimit: plan.effectiveSettings.contextLimit,
		responseBudget: plan.effectiveSettings.responseBudget,
		safetyAllowance: plan.effectiveSettings.safetyAllowance,
		siblingGenerationLimit: plan.effectiveSettings.siblingGenerationLimit,
		continuationStrategy: plan.effectiveSettings.continuationStrategy,
		continuationInstruction: plan.effectiveSettings.continuationInstruction,
		continuationPrefillSuffix: plan.effectiveSettings.continuationPrefillSuffix,
	} satisfies GenerationProvenanceSettings;
	const provenanceRecord: GenerationProvenanceRecord = {
		connectionProfileId: connection?.profileId ?? null,
		connectionSettingsRevision: connection?.settingsRevision ?? null,
		modelBackend: connection?.backend ?? null,
		adapter: connection?.adapter ?? null,
		modelId: plan.effectiveSettings.modelId,
		generationSettings,
		usage: null,
		finishReason: null,
		status: null,
		interruptionCause: null,
	};
	return {
		namespace: "generation",
		key: "provenance",
		value: generationProvenanceCodec.encode(provenanceRecord),
	} satisfies ConversationDataEntry;
};

export interface CapturedGeneration {
	readonly plan: GenerationPlan;
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
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly provenance: ConversationDataEntry;
}

/**
 * ==[HUMAN APPROVED]== Project one captured Generation into the fields shared by every acceptance
 * command. Each workflow spreads this projection alongside its lifecycle-
 * specific target fields, keeping those differences visible at the callsite.
 */
export function capturedAcceptanceFields(
	capture: CapturedGeneration,
	input: { conversationId: number; timestamp: string },
) {
	return {
		conversationId: input.conversationId,
		timestamp: input.timestamp,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		capturedHumanName: capture.humanParticipant.name,
		capturedModelName: capture.author.capturedName,
		promptPlan: promptPlanJson(capture.plan.promptPlan),
		promptInspection: promptInspectionJson(capture.plan.budget),
		historyRoles: capture.historyRoles,
		generationSettings: generationSettingsJson(capture.plan.effectiveSettings),
		connection: connectionJson(capture.connection),
		provenance: capture.provenance,
	} satisfies Pick<
		AcceptTailGenerationInput,
		"conversationId" | "timestamp" | "humanParticipantId" | "modelParticipantId" |
		"capturedHumanName" | "capturedModelName" | "promptPlan" | "promptInspection" |
		"historyRoles" | "generationSettings" | "connection" | "provenance"
	>;
}

/** ==[HUMAN APPROVED]== Build the common provider-neutral request for an accepted Generation. */
export function modelRequestFor(
	capture: CapturedGeneration,
	input: Pick<GenerationAttemptInput, "signal">,
): ModelClientGenerationInput {
	return {
		promptPlan: capture.plan.promptPlan,
		historyRoles: capture.historyRoles,
		modelId: capture.plan.effectiveSettings.modelId,
		generationSettings: projectModelClientGenerationSettings(capture.plan.effectiveSettings),
		connection: capture.connection,
		signal: input.signal,
	};
}

/**
 * ==[HUMAN APPROVED]== Assemble the shared Generation-start capture every lifecycle builds: the
 * complete compiled Generation Plan, the retained history roles, the Control
 * pair, the model author stamp, and the provenance capture.
 */
const toCapturedGeneration = (
	derivation: GenerationDerivation,
	configuration: AttemptConfiguration,
	plan: GenerationPlan,
): CapturedGeneration => ({
	plan,
	historyRoles: plan.budget.retainedHistoryRoles,
	humanParticipant: { id: derivation.human.id, name: derivation.human.name },
	author: {
		participantId: derivation.model.id,
		capturedName: derivation.model.name,
	},
	control: {
		humanParticipantId: derivation.human.id,
		modelParticipantId: derivation.model.id,
	},
	connection: configuration.connection,
	provenance: generationProvenanceEntry(plan, configuration.connection),
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
	return connectionSnapshotOf(settings, profile);
}

// ==[HUMAN APPROVED]== Active Generation persistence stores only a closed JSON projection of the
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

// ==[HUMAN APPROVED]== Active Generation persistence stores the attempt's Effective Generation
// Settings for inspection. The projection is compile-locked to the canonical
// vocabulary: adding a canonical field fails typecheck until persistence
// states what it stores — the completeness gap that previously let the
// Safety allowance silently disappear from active inspection. The stored
// values describe the attempt: an intent-inapplicable Continuation operand
// is stored as null, never as the configured-but-unused value.
export type PersistedGenerationSettings = {
	readonly [K in GenerationSettingsField]: ConversationJsonValue;
};

export const generationSettingsJson = (
	effective: EffectiveGenerationSettings,
): PersistedGenerationSettings => ({
	modelId: effective.modelId,
	siblingGenerationLimit: effective.siblingGenerationLimit,
	temperature: effective.temperature,
	topP: effective.topP,
	frequencyPenalty: effective.frequencyPenalty,
	presencePenalty: effective.presencePenalty,
	contextLimit: effective.contextLimit,
	responseBudget: effective.responseBudget,
	safetyAllowance: effective.safetyAllowance,
	continuationStrategy: effective.continuationStrategy,
	continuationInstruction: effective.continuationInstruction,
	continuationPrefillSuffix: effective.continuationPrefillSuffix,
	requestOverrides: effective.requestOverrides,
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
			apiFormat: connection.apiFormat,
		};

// ==[HUMAN APPROVED]== Active inspection keeps the exact budget decision made at Generation
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

// ==[HUMAN APPROVED]== Build the candidate Prompt Plan without writing it. A retry reuses the
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
	const configuration = captureConfiguration(
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
		latest.author?.participantId === derivation.human.id &&
		latestSelected?.content === content
		? latest.id
		: undefined;
	const history = reuseHumanMessageId === undefined
		? [...derivation.history, {
			speakerName: derivation.human.name,
			content,
		}]
		: derivation.history;
	const historyRoles = reuseHumanMessageId === undefined
		? [...derivation.historyRoles, "human" as const]
		: derivation.historyRoles;
	// ==[HUMAN APPROVED]== An ordinary Tail Generation carries no Continuation intent, so the
	// compiled plan has no applicable Continuation operand either.
	const plan = assertGenerationPlan(compileGenerationPlan({
		human: toCompilerDefinition(derivation.human),
		model: toCompilerDefinition(derivation.model),
		history,
		historyRoles,
		settings: configuration.settings,
		connection: configuration.connection,
		estimator: tokenEstimator,
	}));
	return {
		...toCapturedGeneration(derivation, configuration, plan),
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
	if (hasActiveGeneration(database, snapshot.id)) {
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
	const configuration = captureConfiguration(
		database,
		snapshot.id,
		connection,
		connectionSettingsOptions,
	);
	if (configuration.settings.continuationStrategy !== "instruction") {
		if (selected.content.length === 0) {
			throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
		}
	}
	const intent = continuationIntentFor(configuration.settings);
	// ==[HUMAN APPROVED]== A prior model Message can have been authored by the Participant who held
	// model Control at that time. Preserve that role in the continuation's
	// provider input even when the current model Control has moved on.
	const continuationHistory = selectedHistoryFrom(
		snapshot,
		derivation.human.id,
		derivation.model.id,
		undefined,
		(message) => {
			const authorId = message.author?.participantId;
			if (
				message.historicalContext?.modelParticipantId === authorId ||
				authorId === derivation.model.id
			) {
				return "model";
			}
			if (
				message.historicalContext?.humanParticipantId === authorId ||
				authorId === derivation.human.id
			) {
				return "human";
			}
			return null;
		},
	);
	// ==[HUMAN APPROVED]== The compiler owns intent applicability: an assistant-prefill Continuation
	// protects its prefixed model text, an instruction Continuation protects
	// the latest human entry, and the effective settings retain exactly the
	// applicable Continuation operand.
	const plan = assertGenerationPlan(compileGenerationPlan({
		human: toCompilerDefinition(derivation.human),
		model: toCompilerDefinition(derivation.model),
		history: continuationHistory.entries,
		historyRoles: continuationHistory.roles,
		intent,
		settings: configuration.settings,
		connection: configuration.connection,
		estimator: tokenEstimator,
	}));
	return {
		...toCapturedGeneration(derivation, configuration, plan),
		precedingMessageId: latest.id,
		precedingVariantId: selected.id,
		intent,
		assistantPrefill: configuration.settings.continuationStrategy === "assistant-prefill"
			? {
				prefix: selected.content,
				suffix: configuration.settings.continuationPrefillSuffix,
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

	// ==[HUMAN APPROVED]== Same derived rule as the snapshot exposes: playable Conversation,
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
		// ==[HUMAN APPROVED]== The discriminated eligibility narrows the remaining reasons to the
		// two historical denials; no fallback reason is ever fabricated.
		throw new SiblingVariantUnavailableError(eligibility.reason);
	}

	const context = target.historicalContext;
	if (context === null) {
		// Unreachable after the eligibility check; keeps the pair trusted. ==[HUMAN APPROVED]==
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

	// ==[HUMAN APPROVED]== Selected history strictly preceding the target Message. Excluding the
	// target by construction also excludes all of its existing sibling
	// Variants: an alternative never prompts on another alternative.
	const selectedHistory = selectedHistoryFrom(
		snapshot,
		human.id,
		model.id,
		targetIndex,
	);

	// ==[HUMAN APPROVED]== The historical pair's current Definitions and names, so a rename or
	// Prompt edit before this generation starts contributes; the Message
	// itself keeps displaying its captured author name.
	return {
		human,
		model,
		history: selectedHistory.entries,
		historyRoles: selectedHistory.roles,
	};
};

export function captureSiblingGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	input: {
		messageId: number;
		connection?: ModelClientConnectionSnapshot | null | undefined;
		connectionSettings?: ConnectionSettingsModuleOptions | undefined;
		tokenEstimator?: TokenEstimator | undefined;
	},
): CapturedGeneration {
	const derivation = deriveSiblingDerivation(snapshot, input.messageId);
	const configuration = captureConfiguration(
		database,
		snapshot.id,
		input.connection,
		input.connectionSettings,
	);
	// ==[HUMAN APPROVED]== A Sibling Generation carries the sibling intent and no applicable
	// Continuation operand.
	const plan = assertGenerationPlan(compileGenerationPlan({
		human: toCompilerDefinition(derivation.human),
		model: toCompilerDefinition(derivation.model),
		history: derivation.history,
		historyRoles: derivation.historyRoles,
		intent: { type: "sibling" },
		settings: configuration.settings,
		connection: configuration.connection,
		estimator: input.tokenEstimator,
	}));
	return toCapturedGeneration(derivation, configuration, plan);
}
