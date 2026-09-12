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
import { readConversationPromptPresetRecipe } from "../prompt-preset";
import type { PromptPresetSlot } from "../prompt-preset";
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
	PromptContextEntry,

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
import type { MacroEnvironment } from "../../shared/prompt-macro-engine";
import type { MacroVariableWrite } from "../../shared/contract/macro-variables";
import { deriveMacroState } from "../prompt-macros";

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
	context: readonly PromptContextEntry[];
}

export type GenerationAttemptKind = "send" | "continuation" | "sibling";

export interface ParticipatingHistory {
	readonly messages: readonly ConversationSnapshot["messages"][number][];
	readonly control: ConversationSnapshot["control"];
	readonly target: ConversationSnapshot["messages"][number] | undefined;
}

// ==[HUMAN APPROVED]== One boundary decides the history and historical Control pair an attempt
// sees. A missing sibling target contributes no history and falls back to the
// current Control pair; the generation-specific eligibility check still rejects
// that target before any provider request can start.
export const participatingHistoryFor = (
	snapshot: ConversationSnapshot,
	kind: GenerationAttemptKind,
	messageId?: number,
): ParticipatingHistory => {
	if (kind !== "sibling" || messageId === undefined) {
		return {
			messages: snapshot.messages,
			control: snapshot.control,
			target: undefined,
		};
	}
	const targetIndex = snapshot.messages.findIndex((message) => message.id === messageId);
	const target = targetIndex < 0 ? undefined : snapshot.messages[targetIndex];
	return {
		messages: target === undefined ? [] : snapshot.messages.slice(0, targetIndex),
		control: target?.historicalContext ?? snapshot.control,
		target,
	};
};

// ==[HUMAN APPROVED]== The one authorship rule every Generation kind uses. A Message is model
// writing when its Author Stamp matches the current model Control seat or the
// model Participant of its own captured historical Control pair, and human
// writing under the mirrored rule. Consulting the captured pair is what keeps
// a Control reassignment from re-presenting earlier model writing as the
// writer's own; deriving the role from current Control alone made Send and
// Sibling disagree with Continuation about the same Message.
const roleForMessage = (
	message: ConversationSnapshot["messages"][number],
	humanParticipantId: number,
	modelParticipantId: number,
): "human" | "model" | null => {
	const authorId = message.author?.participantId;
	if (authorId === undefined || authorId === null) return null;
	if (
		authorId === modelParticipantId ||
		message.historicalContext?.modelParticipantId === authorId
	) {
		return "model";
	}
	if (
		authorId === humanParticipantId ||
		message.historicalContext?.humanParticipantId === authorId
	) {
		return "human";
	}
	return null;
};

// ==[HUMAN APPROVED]== Selected-history entries for prompt compilation, derived from each
// Message's selected Variant and its immutable Author Stamp name.
// The caller supplies the already-bounded participating Messages, so this
// helper cannot accidentally include a sibling target or its later history.
const selectedHistoryFrom = (
	messages: readonly ConversationSnapshot["messages"][number][],
	humanParticipantId: number,
	modelParticipantId: number,
): readonly PromptContextEntry[] => {
	const entries: PromptContextEntry[] = [];

	for (const message of messages) {
		const selected = message.variants.find((variant) => variant.selected);
		if (selected === undefined) continue;

		entries.push({
			kind: "message",
			speakerName: message.author?.capturedName ?? null,
			content: selected.content,
			role: roleForMessage(message, humanParticipantId, modelParticipantId),
		});
	}

	return entries;
};

export const deriveGeneration = (
	snapshot: ConversationSnapshot,
): GenerationDerivation | null => {
	const participation = participatingHistoryFor(snapshot, "send");
	const human = snapshot.cast.find(
		(participant) => participant.id === participation.control.humanParticipantId,
	);
	const model = snapshot.cast.find(
		(participant) => participant.id === participation.control.modelParticipantId,
	);
	if (human === undefined || model === undefined || human.id === model.id) {
		return null;
	}

	return { human, model, context: selectedHistoryFrom(participation.messages, human.id, model.id) };
};

/**
 * ==[HUMAN APPROVED]== The one Generation Plan compilation. Every attempt and read-only
 * inspection compiles the same way from a derived Control pair, its ordered
 * writing context, and the captured configuration; only the Generation intent
 * and the estimator differ, so those are the only arguments a call site
 * states.
 */
export const compilePlanFrom = (
	derivation: GenerationDerivation,
	configuration: {
		settings: ConversationGenerationSettings;
		slots: readonly PromptPresetSlot[];
		macroEnvironment: MacroEnvironment;
		connection: GenerationConnectionFacts | null;
	},
	options: {
		intent?: GenerationIntent | undefined;
		estimator?: TokenEstimator | undefined;
	} = {},
): GenerationPlan => compileGenerationPlan({
	human: toCompilerDefinition(derivation.human),
	model: toCompilerDefinition(derivation.model),
	context: derivation.context,
	recipe: configuration.slots,
	macroEnvironment: configuration.macroEnvironment,
	intent: options.intent,
	settings: configuration.settings,
	connection: configuration.connection,
	estimator: options.estimator,
});

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

interface AttemptConfiguration {
	settings: ConversationGenerationSettings;
	slots: readonly PromptPresetSlot[];
	promptPresetId: number;
	macroEnvironment: MacroEnvironment;
	connection: ModelClientConnectionSnapshot | null;
}

// ==[HUMAN APPROVED]== The one attempt-configuration read: every Generation start and the
// read-only inspection capture the same settings and the same recipe slots, so
// a missing Conversation fails identically wherever an attempt is captured.
export function captureConfiguration(
	database: Database,
	conversationId: number,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
	macroOptions: Pick<MacroEnvironment, "timeZone" | "locale"> = {},
): AttemptConfiguration {
	const conversation = createConversationModule(database);
	const settings = conversation.getGenerationSettings(conversationId);
	const recipe = readConversationPromptPresetRecipe(database, conversationId);
	if (settings === undefined || recipe === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	const capturedConnection = connection === undefined
		? resolveConnectionSnapshot(database, connectionSettingsOptions)
		: connection;
	return {
		settings,
		slots: recipe.slots,
		promptPresetId: recipe.id,
		macroEnvironment: {
			self: "",
			other: "",
			conversationId,
			promptPresetId: recipe.id,
			now: new Date(),
			timeZone: macroOptions.timeZone,
			locale: macroOptions.locale,
			variables: new Map(),
			expansionCache: new Map(),
		},
		connection: capturedConnection,
	};
}

// ==[HUMAN APPROVED]== The effective Macro State is reconstructed from the Conversation's
// preset-scoped baseline and selected Variant records. An attempt gets a fresh
// mutable copy, so sibling completions can never mutate another attempt's input.
export const configurationFor = (
	configuration: AttemptConfiguration,
	snapshot: ConversationSnapshot,
	participatingMessages: readonly ConversationSnapshot["messages"][number][] = snapshot.messages,
): AttemptConfiguration => ({
	...configuration,
	macroEnvironment: {
		...configuration.macroEnvironment,
		variables: deriveMacroState({
			initialData: snapshot.data,
			presetId: configuration.promptPresetId,
			selectedVariants: participatingMessages
				.flatMap((message) => message.variants.filter((variant) => variant.selected)),
		}),
		writes: [],
		expansionCache: new Map(),
	},
});

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
	readonly context: readonly PromptContextEntry[];
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
	readonly macroPresetId: number;
	readonly macroWrites: readonly MacroVariableWrite[];
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
		promptPlan: capture.plan.promptPlan,
		promptInspection: promptInspectionJson(capture.plan.budget),
		promptContext: promptContextJson(capture.context),
		generationSettings: generationSettingsJson(capture.plan.effectiveSettings),
		connection: connectionJson(capture.connection),
		provenance: capture.provenance,
		macroPresetId: capture.macroPresetId,
		macroWrites: capture.macroWrites,
	} satisfies Pick<
		AcceptTailGenerationInput,
		"conversationId" | "timestamp" | "humanParticipantId" | "modelParticipantId" |
		"capturedHumanName" | "capturedModelName" | "promptPlan" | "promptInspection" |
		"promptContext" | "generationSettings" | "connection" | "provenance" |
		"macroPresetId" | "macroWrites"
	>;
}

/** ==[HUMAN APPROVED]== Build the common provider-neutral request for an accepted Generation. */
export function modelRequestFor(
	capture: CapturedGeneration,
	input: Pick<GenerationAttemptInput, "signal">,
): ModelClientGenerationInput {
	return {
		promptPlan: capture.plan.promptPlan,
		modelId: capture.plan.effectiveSettings.modelId,
		generationSettings: projectModelClientGenerationSettings(capture.plan.effectiveSettings),
		connection: capture.connection,
		signal: input.signal,
	};
}

/**
 * ==[HUMAN APPROVED]== Assemble the shared Generation-start capture every lifecycle builds: the
 * complete compiled Generation Plan, the retained writing context, the Control
 * pair, the model author stamp, and the provenance capture.
 */
const toCapturedGeneration = (
	derivation: GenerationDerivation,
	configuration: AttemptConfiguration,
	plan: GenerationPlan,
): CapturedGeneration => ({
	plan,
	context: plan.budget.retainedContext,
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
	macroPresetId: configuration.promptPresetId,
	macroWrites: [...(configuration.macroEnvironment.writes ?? [])],
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

// ==[HUMAN APPROVED]== The persisted writing context: one closed JSON projection of the ordered
// entries, each carrying its own role. Nothing aligns a second list against
// it, so a stored context cannot be read back misaligned.
export const promptContextJson = (
	context: readonly PromptContextEntry[],
): ConversationJsonValue => context.map((entry) => ({
	kind: entry.kind,
	speakerName: entry.speakerName,
	content: entry.content,
	role: entry.role,
}));

// ==[HUMAN APPROVED]== Active Generation persistence stores only a closed JSON projection of the
// provider-neutral captures. These explicit projections keep provider and
// class instances out of the Conversation domain boundary.
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
	omittedContext: budget.omittedContext.map((entry) => ({
		kind: entry.kind,
		speakerName: entry.speakerName,
		content: entry.content,
		role: entry.role,
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
	macroOptions: Pick<MacroEnvironment, "timeZone" | "locale"> = {},
	options: { assertBudget?: boolean } = {},
): SendGenerationCapture {
	const configuration = captureConfiguration(
		database,
		snapshot.id,
		connection,
		connectionSettingsOptions,
		macroOptions,
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
	// ==[HUMAN APPROVED]== A fresh Send budgets the submitted human writing as part of the context;
	// a retry reuses the already accepted trailing human Message, which is
	// already in it.
	const submitted = reuseHumanMessageId === undefined
		? {
			...derivation,
			context: [...derivation.context, {
				kind: "message",
				speakerName: derivation.human.name,
				content,
				role: "human",
			}] satisfies readonly PromptContextEntry[],
		}
		: derivation;
	// ==[HUMAN APPROVED]== An ordinary Tail Generation carries no Continuation intent, so the
	// compiled plan has no applicable Continuation operand either.
	const preparedConfiguration = configurationFor(configuration, snapshot);
	const plan = compilePlanFrom(submitted, preparedConfiguration, { estimator: tokenEstimator });
	if (options.assertBudget !== false) assertGenerationPlan(plan);
	return {
		...toCapturedGeneration(derivation, preparedConfiguration, plan),
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
	macroOptions: Pick<MacroEnvironment, "timeZone" | "locale"> = {},
	options: { assertBudget?: boolean } = {},
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
		macroOptions,
	);
	if (configuration.settings.continuationStrategy !== "instruction") {
		if (selected.content.length === 0) {
			throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
		}
	}
	const intent = continuationIntentFor(configuration.settings);
	// ==[HUMAN APPROVED]== The compiler owns intent applicability: an assistant-prefill Continuation
	// protects its prefixed model text, an instruction Continuation protects
	// the latest human entry, and the effective settings retain exactly the
	// applicable Continuation operand.
	const preparedConfiguration = configurationFor(configuration, snapshot);
	const plan = compilePlanFrom(derivation, preparedConfiguration, { intent, estimator: tokenEstimator });
	if (options.assertBudget !== false) assertGenerationPlan(plan);
	return {
		...toCapturedGeneration(derivation, preparedConfiguration, plan),
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
): GenerationDerivation => {
	const participation = participatingHistoryFor(snapshot, "sibling", messageId);
	const target = participation.target;
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

	const historicalPair = participation.control;
	const human = snapshot.cast.find(
		(participant) => participant.id === historicalPair.humanParticipantId,
	);
	const model = snapshot.cast.find(
		(participant) => participant.id === historicalPair.modelParticipantId,
	);
	if (human === undefined || model === undefined) {
		throw new SiblingVariantUnavailableError(
			"historical-participant-unavailable",
		);
	}

	// ==[HUMAN APPROVED]== Selected history strictly preceding the target Message. Excluding the
	// target by construction also excludes all of its existing sibling
	// Variants: an alternative never prompts on another alternative.
	const context = selectedHistoryFrom(participation.messages, human.id, model.id);

	// ==[HUMAN APPROVED]== The historical pair's current Definitions and names, so a rename or
	// Prompt edit before this generation starts contributes; the Message
	// itself keeps displaying its captured author name.
	return { human, model, context };
};

export function captureSiblingGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	input: {
		messageId: number;
		connection?: ModelClientConnectionSnapshot | null | undefined;
		connectionSettings?: ConnectionSettingsModuleOptions | undefined;
		tokenEstimator?: TokenEstimator | undefined;
		macroTimeZone?: string;
		macroLocale?: string;
		assertBudget?: boolean;
	},
): CapturedGeneration {
	const derivation = deriveSiblingDerivation(snapshot, input.messageId);
	const configuration = captureConfiguration(
		database,
		snapshot.id,
		input.connection,
		input.connectionSettings,
		{ timeZone: input.macroTimeZone, locale: input.macroLocale },
	);
	// ==[HUMAN APPROVED]== A Sibling Generation carries the sibling intent and no applicable
	// Continuation operand.
	const preparedConfiguration = configurationFor(
		configuration,
		snapshot,
		participatingHistoryFor(snapshot, "sibling", input.messageId).messages,
	);
	const plan = compilePlanFrom(derivation, preparedConfiguration, {
		intent: { type: "sibling" },
		estimator: input.tokenEstimator,
	});
	if (input.assertBudget !== false) assertGenerationPlan(plan);
	return toCapturedGeneration(derivation, preparedConfiguration, plan);
}
