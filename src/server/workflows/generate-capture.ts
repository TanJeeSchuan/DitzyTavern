import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import {
	ConversationNotPlayableError,
	ConversationNotFoundError,
	ContinuationUnavailableError,
	deriveMessageSwipeEligibility,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	type AcceptTailGenerationInput,
	type ConversationDataEntry,
	type ConversationJsonValue,
	type ConversationSnapshot,
} from "../conversation";
import type { ConversationGenerationSettings } from "../conversation";
import { readConversationPromptPresetRecipeFromConnection } from "../prompt-preset";
import type { PromptPresetRecipe, PromptPresetSlot } from "../prompt-preset";
import { evaluateScopedLore, evaluateScopedLoreAsync, noLoreEvaluation, type ScopedLoreEvaluation } from "../lorebook/evaluation";
import type { CastParticipantSnapshot } from "../conversation/types";
import { readConversationSummaryFromConnection } from "../conversation/snapshot";
import { readConversationGenerationSettingsFromConnection } from "../conversation/generation-settings";
import { readSelectedHistoryFromConnection } from "../conversation/selected-history";
import { runConversationReadTransaction } from "../conversation/commands/transaction";
import {
	compileGenerationPlan,
	continuationIntentFor,
	effectiveGenerationSettingsFor,
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
import type { ModelFetch } from "../model-client/types";
import { projectModelClientGenerationSettings } from "../model-client";
import type { GenerationAttemptInput } from "./generate-server-owned";
import {
	generationProvenanceCodec,
	type GenerationProvenanceRecord,
	type GenerationProvenanceSettings,
} from "../../shared/generation-provenance";
import { type GenerationSettingsField } from "../../shared/contract/generation-settings";
import {
	createAttemptEnvironment,
	type AttemptEnvironment,
} from "../../shared/prompt-macro-engine";
import {
	conversationGenerationSettings,
	type GenerationFormattingContext,
} from "../../shared/contract/conversation-schema";
import type { MacroVariableWrite } from "../../shared/contract/macro-variables";
import {
	deriveMacroState,
	MACRO_DATA_NAMESPACE,
	macroInitialValuePrefix,
	macroWritesKey,
} from "../prompt-macros";
import type { MacroValue } from "../../shared/contract/macro-variable-write";
import type { SelectedHistoryRead } from "../conversation";

// ==[HUMAN APPROVED]== Generation-start capture: from one authoritative Conversation preparation and
// the captured configuration this module derives the complete Generation Plan
// through the one Generation Plan Compiler, together with the captured
// participants and Control pair and the provenance record every server-owned
// Generation persists at start. The workflow entry points consume these
// captures; nothing here contacts a transport or mutates Conversation state.

export interface ParticipantPreview {
	id: number;
	name: string;
}

export interface GenerationDerivation {
	human: CastParticipantSnapshot;
	model: CastParticipantSnapshot;
	context: readonly PromptContextEntry[];
}

export type GenerationAttemptKind = "send" | "continuation" | "sibling";

export interface ParticipatingHistory {
	readonly messages: readonly ParticipatingHistoryMessage[];
	readonly control: ConversationSnapshot["control"];
}

export type ParticipatingHistoryMessage = SelectedHistoryRead["messages"][number];

const participatingHistoryFromRead = (
	read: SelectedHistoryRead,
	control: ConversationSnapshot["control"],
): ParticipatingHistory => ({
	messages: read.messages,
	control,
});

// ==[HUMAN APPROVED]== The one authorship rule every Generation kind uses. A Message is model
// writing when its Author Stamp matches the current model Control seat or the
// model Participant of its own captured historical Control pair, and human
// writing under the mirrored rule. Consulting the captured pair is what keeps
// a Control reassignment from re-presenting earlier model writing as the
// writer's own; deriving the role from current Control alone made Send and
// Sibling disagree with Continuation about the same Message.
const roleForMessage = (
	message: Pick<ParticipatingHistoryMessage, "author" | "historicalContext">,
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
	messages: readonly ParticipatingHistoryMessage[],
	humanParticipantId: number,
	modelParticipantId: number,
): readonly PromptContextEntry[] => {
	const entries: PromptContextEntry[] = [];

	for (const message of messages) {
		if (message.variant === null) continue;

		entries.push({
			kind: "message",
			speakerName: message.author?.capturedName ?? null,
			content: message.variant.content,
			role: roleForMessage(message, humanParticipantId, modelParticipantId),
		});
	}

	return entries;
};

/** ==[HUMAN APPROVED]==
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
		attempt: AttemptEnvironment;
		connection: GenerationConnectionFacts | null;
		lore: ScopedLoreEvaluation;
	},
	options: {
		intent?: GenerationIntent | undefined;
		estimator?: TokenEstimator | undefined;
	} = {},
): GenerationPlan => {
	const compiled = compileGenerationPlan({
		human: toCompilerDefinition(derivation.human),
		model: toCompilerDefinition(derivation.model),
		context: derivation.context,
		recipe: configuration.slots,
		lore: configuration.lore.candidates,
		loreAllowance: configuration.lore.allowance,
		loreActivation: configuration.lore.activation,
		attempt: configuration.attempt,
		intent: options.intent,
		settings: configuration.settings,
		connection: configuration.connection,
		estimator: options.estimator,
	});
	const automaticLoreText = compiled.promptPlan.blocks.find((block) => block.kind === "lore")?.content ?? "";
	return {
		...compiled,
		loreActivation: compiled.loreActivation === null ? null : {
			...compiled.loreActivation,
			automaticLoreText,
			finalLoreText: automaticLoreText,
		},
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

interface AttemptConfiguration {
	settings: ConversationGenerationSettings;
	slots: readonly PromptPresetSlot[];
	promptPresetId: number;
	attempt: AttemptEnvironment;
	connection: ModelClientConnectionSnapshot | null;
	lore: ScopedLoreEvaluation;
}

interface GenerationPreparationBase {
	readonly conversationId: number;
	readonly formatting: GenerationFormattingContext;
	readonly derivation: GenerationDerivation;
	readonly participation: ParticipatingHistory;
	readonly settings: ConversationGenerationSettings;
	readonly effectiveSettings: EffectiveGenerationSettings;
	readonly recipe: PromptPresetRecipe;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly macroState: ReadonlyMap<string, MacroValue>;
	readonly lore: ScopedLoreEvaluation;
}

const connectionIdentityOf = (
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

export type GenerationPreparation = GenerationPreparationBase & (
	| { readonly kind: "send"; readonly content: string }
	| { readonly kind: "continuation" }
	| { readonly kind: "sibling"; readonly messageId: number }
);

export interface SendReuseTarget {
	messageId: number;
	variantId: number;
}

const reusableHumanMessageId = (
	messages: readonly ParticipatingHistoryMessage[],
	humanParticipantId: number,
	content: string,
): number | undefined => {
	const latest = messages.at(-1);
	const variant = latest?.variant;
	return latest !== undefined &&
		variant !== null &&
		variant !== undefined &&
		latest.author?.participantId === humanParticipantId &&
		variant.content === content
		? latest.id
		: undefined;
};

export const sendReuseTargetOf = (
	preparation: GenerationPreparation,
): SendReuseTarget | undefined => {
	if (preparation.kind !== "send") return undefined;
	const messageId = reusableHumanMessageId(
		preparation.participation.messages,
		preparation.derivation.human.id,
		preparation.content,
	);
	if (messageId === undefined) return undefined;
	const variant = preparation.participation.messages.at(-1)?.variant;
	if (variant === null || variant === undefined) return undefined;
	return { messageId, variantId: variant.id };
};

const effectiveSettingsForPreparation = (input: {
	readonly settings: ConversationGenerationSettings;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly kind: GenerationAttemptKind;
}): EffectiveGenerationSettings => {
	const intent = input.kind === "continuation"
		? continuationIntentFor(input.settings)
		: input.kind === "sibling"
			? { type: "sibling" as const }
			: undefined;
	return effectiveGenerationSettingsFor(input.settings, intent, input.connection);
};

interface PrepareGenerationInputsBase {
	readonly database: Database;
	readonly conversationId: number;
	readonly connection?: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions;
	readonly formatting?: GenerationFormattingContext;
	/** ==[HUMAN APPROVED]== Test/control seam for the application-wide OpenAI-compatible embedding service. */
	readonly embeddingFetch?: ModelFetch;
}

export type PrepareGenerationInputs = PrepareGenerationInputsBase & (
	| { readonly kind: "send"; readonly content: string }
	| { readonly kind: "continuation" }
	| { readonly kind: "sibling"; readonly messageId: number }
);

/** ==[HUMAN APPROVED]==
 * Read the deterministic inputs for one attempt through the focused Conversation seams. The
 * returned object is safe to retain: compilation and preview validation can use it without
 * rereading mutable history or executing macros.
 */
export function prepareGenerationInputs(
	input: PrepareGenerationInputs,
): GenerationPreparation {
	const { summary, recipe, settings, selected, connection } = runConversationReadTransaction(
		input.database,
		(db) => {
			const summary = readConversationSummaryFromConnection(db, input.conversationId);
			if (summary === undefined) throw new ConversationNotFoundError(input.conversationId);
			const recipe = readConversationPromptPresetRecipeFromConnection(db, input.conversationId);
			const settings = readConversationGenerationSettingsFromConnection(db, input.conversationId);
			if (recipe === undefined || settings === undefined) {
				throw new InvalidConversationCommandError("The Conversation's generation inputs are unavailable.");
			}
			const selected = readSelectedHistoryFromConnection(db, input.conversationId, {
				targetMessageId: input.kind === "sibling" ? input.messageId : undefined,
				conversationDataNamespace: MACRO_DATA_NAMESPACE,
				conversationDataKeyPrefix: macroInitialValuePrefix(recipe.id),
				variantDataKeys: [macroWritesKey(recipe.id), "reasoning"],
			});
			if (selected === undefined) throw new ConversationNotFoundError(input.conversationId);
			const connection = input.connection === undefined
				? resolveConnectionSnapshot(input.database, settings.connectionProfileId, input.connectionSettings)
				: input.connection;
			return { summary, recipe, settings, selected, connection };
		},
	);
	if (!Value.Check(conversationGenerationSettings, settings)) {
		throw new Error("Conversation Generation Settings are corrupt.");
	}
	if (input.kind === "continuation" && summary.activeGenerations.length > 0) {
		throw new ContinuationUnavailableError("active-generation");
	}
	if (input.kind === "sibling") {
		const eligibility = deriveMessageSwipeEligibility(
			summary.playable,
			selected.target?.historicalContext ?? null,
			summary.cast.map((participant) => participant.id),
		);
		if (!eligibility.eligible) {
			if (eligibility.reason === "conversation-not-playable") {
				throw new ConversationNotPlayableError(input.conversationId);
			}
			throw new SiblingVariantUnavailableError(eligibility.reason);
		}
	}
	const participation = participatingHistoryFromRead(selected, {
		humanParticipantId: selected.target?.historicalContext?.humanParticipantId
			?? summary.control.humanParticipantId,
		modelParticipantId: selected.target?.historicalContext?.modelParticipantId
			?? summary.control.modelParticipantId,
	});
	const human = summary.cast.find((participant) =>
		participant.id === participation.control.humanParticipantId);
	const model = summary.cast.find((participant) =>
		participant.id === participation.control.modelParticipantId);
	if (human === undefined || model === undefined || human.id === model.id) {
		throw new ConversationNotPlayableError(input.conversationId);
	}
	const derivation: GenerationDerivation = {
		human,
		model,
		context: selectedHistoryFrom(participation.messages, human.id, model.id),
	};
	const reuseHumanMessageId = input.kind === "send"
		? reusableHumanMessageId(participation.messages, human.id, input.content)
		: undefined;
	const lore = recipe.slots.some((slot) => slot.reference === "lore" && slot.enabled)
		? evaluateScopedLore({
			database: input.database,
			conversationId: input.conversationId,
			messages: participation.messages.flatMap((message) => message.variant === null ? [] : [{ id: message.id, content: message.variant.content }]),
			pendingHumanText: input.kind === "send" && reuseHumanMessageId === undefined ? input.content : undefined,
			embeddingSettings: input.connectionSettings,
		})
		: noLoreEvaluation();
	if (input.kind === "continuation") {
		const latest = participation.messages.at(-1);
		const selectedVariant = latest?.variant;
		const latestWasModelAuthored = latest !== undefined &&
			roleForMessage(latest, human.id, model.id) === "model";
		const hasUsableOutput = selectedVariant !== null && selectedVariant !== undefined &&
			(selectedVariant.content.length > 0 || selectedVariant.data.some(
				(entry) => entry.namespace === "generation" && entry.key === "reasoning" && entry.value.length > 0,
			));
		if (latest === undefined || !latestWasModelAuthored || !hasUsableOutput) {
			throw new ContinuationUnavailableError("not-terminal-model-message");
		}
		if (settings.continuationStrategy === "assistant-prefill" && selectedVariant.content.length === 0) {
			throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
		}
	}
	const formatting = {
		timeZone: input.formatting?.timeZone,
		locale: input.formatting?.locale,
	};
	const effectiveSettings = effectiveSettingsForPreparation({ kind: input.kind, settings, connection });
	const macroState = new Map(deriveMacroState({
		initialData: selected.initialData,
		presetId: recipe.id,
		selectedVariants: participation.messages.map((message) => ({
			selected: message.variant !== null,
			data: message.variant?.data ?? [],
		})),
	}));
	const preparation = {
		conversationId: input.conversationId,
		formatting,
		derivation,
		participation,
		settings,
		effectiveSettings,
		recipe,
		connection,
		macroState,
		lore,
	};
	if (input.kind === "send") return { ...preparation, kind: input.kind, content: input.content };
	if (input.kind === "sibling") return { ...preparation, kind: input.kind, messageId: input.messageId };
	return { ...preparation, kind: input.kind };
}

/** ==[HUMAN APPROVED]==
 * Capture the same immutable inputs as prepareGenerationInputs, completing the one
 * asynchronous semantic pass before a Generation Plan is compiled. The returned
 * value stays synchronous when no semantic pass is needed, so generation can
 * reserve its captured inputs before another command races the attempt.
 */
export function prepareGenerationInputsAsync(
	input: PrepareGenerationInputs,
	capturedPreparation?: GenerationPreparation,
): GenerationPreparation | Promise<GenerationPreparation> {
	// ==[HUMAN APPROVED]== Active Generations pass their already-captured preparation here. The
	// semantic request may suspend, but books, attachments, history, settings, and
	// participant data must remain the exact values captured before that suspension.
	const preparation = capturedPreparation ?? prepareGenerationInputs(input);
	if (!preparation.recipe.slots.some((slot) => slot.reference === "lore" && slot.enabled)) return preparation;
	// ==[HUMAN APPROVED]== The synchronous capture already proves that no enabled entry has semantic
	// triggers when its mode is not keyword-fallback. Avoid an unnecessary
	// Promise turn in that common path: acceptance must remain atomic with the
	// captured author/control facts even when another edit races the attempt.
	const needsSemantic = preparation.lore.activation.mode === "keyword-fallback";
	if (!needsSemantic) return preparation;
	return evaluateScopedLoreAsync({
		database: input.database,
		conversationId: preparation.conversationId,
		messages: preparation.participation.messages.flatMap((message) => message.variant === null ? [] : [{ id: message.id, content: message.variant.content }]),
		pendingHumanText: preparation.kind === "send" ? preparation.content : undefined,
		fetch: input.embeddingFetch,
	}, preparation.lore.sources).then((lore) => ({ ...preparation, lore }));
}

export const captureConfigurationFromPreparation = (
	preparation: GenerationPreparation,
): AttemptConfiguration => {
	const attempt = createAttemptEnvironment({
		self: preparation.derivation.human.name,
		other: preparation.derivation.model.name,
		conversationId: preparation.conversationId,
		promptPresetId: preparation.recipe.id,
		now: new Date(),
		timeZone: preparation.formatting.timeZone,
		locale: preparation.formatting.locale,
		variables: preparation.macroState,
	});
	return {
		settings: preparation.settings,
		slots: preparation.recipe.slots,
		promptPresetId: preparation.recipe.id,
		attempt,
		connection: preparation.connection,
		lore: preparation.lore,
	};
};

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
	readonly preparation: GenerationPreparation;
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
		loreActivation: capture.plan.loreActivation,
		provenance: capture.provenance,
		macroPresetId: capture.macroPresetId,
		macroWrites: capture.macroWrites,
	} satisfies Pick<
		AcceptTailGenerationInput,
		"conversationId" | "timestamp" | "humanParticipantId" | "modelParticipantId" |
		"capturedHumanName" | "capturedModelName" | "promptPlan" | "promptInspection" |
		"promptContext" | "generationSettings" | "connection" | "loreActivation" | "provenance" |
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
	preparation: GenerationPreparation,
	derivation: GenerationDerivation,
	configuration: AttemptConfiguration,
	plan: GenerationPlan,
): CapturedGeneration => ({
	preparation,
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
	macroWrites: [...configuration.attempt.state.writes],
	provenance: generationProvenanceEntry(plan, configuration.connection),
});

function resolveConnectionSnapshot(
	database: Database,
	profileId: number | null,
	options: ConnectionSettingsModuleOptions | undefined,
): ModelClientConnectionSnapshot | null {
	const settings = createConnectionSettingsModule(database, options).get();
	if (profileId === null) return null;
	const profile = settings.profiles.find((entry) => entry.id === profileId);
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

export function generationSettingsJson(
	effective: EffectiveGenerationSettings,
): PersistedGenerationSettings {
	return {
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
	};
}

export const connectionJson = (
	connection: ModelClientConnectionSnapshot | null,
): ConversationJsonValue => connectionIdentityOf(connection);

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

export interface GenerationCaptureInput {
	database: Database;
	conversationId: number;
	content?: string | undefined;
	messageId?: number | undefined;
	connection?: ModelClientConnectionSnapshot | null | undefined;
	connectionSettings?: ConnectionSettingsModuleOptions | undefined;
	tokenEstimator?: TokenEstimator | undefined;
	formatting?: GenerationFormattingContext | undefined;
	embeddingFetch?: ModelFetch | undefined;
}

export type SendGenerationCaptureInput = GenerationCaptureInput & { content: string };
export type SiblingGenerationCaptureInput = GenerationCaptureInput & { messageId: number };

// ==[HUMAN APPROVED]== Build the candidate Prompt Plan without writing it. A retry reuses the
// already accepted trailing human Message; a fresh Send appends the submitted
// human writing to the selected narrative path before budgeting.
export function captureSendGeneration(
	input: SendGenerationCaptureInput,
): SendGenerationCapture {
	const { conversationId, content } = input;
	const preparation = prepareGenerationInputs({
		database: input.database,
		conversationId,
		kind: "send",
		content,
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
	});
	const { derivation } = preparation;
	const configuration = captureConfigurationFromPreparation(preparation);
	const reuseHumanMessageId = sendReuseTargetOf(preparation)?.messageId;
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
	const plan = compilePlanFrom(submitted, configuration, { estimator: input.tokenEstimator });
	return {
		...toCapturedGeneration(preparation, derivation, configuration, plan),
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

export function captureContinuationGeneration(
	input: GenerationCaptureInput,
): ContinuationGenerationCapture {
	const { conversationId } = input;
	const preparation = prepareGenerationInputs({
		database: input.database,
		conversationId,
		kind: "continuation",
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
	});
	const { derivation } = preparation;
	const latest = preparation.participation.messages.at(-1);
	const selected = latest?.variant;
	if (latest === undefined || selected === null || selected === undefined) {
		throw new ContinuationUnavailableError("not-terminal-model-message");
	}
	const configuration = captureConfigurationFromPreparation(preparation);
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
	const plan = compilePlanFrom(derivation, configuration, { intent, estimator: input.tokenEstimator });
	return {
		...toCapturedGeneration(preparation, derivation, configuration, plan),
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

export function captureSiblingGeneration(
	input: SiblingGenerationCaptureInput,
): CapturedGeneration {
	const { conversationId } = input;
	const preparation = prepareGenerationInputs({
		database: input.database,
		conversationId,
		kind: "sibling",
		messageId: input.messageId,
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
	});
	const { derivation } = preparation;
	const configuration = captureConfigurationFromPreparation(preparation);
	// ==[HUMAN APPROVED]== A Sibling Generation carries the sibling intent and no applicable
	// Continuation operand.
	const plan = compilePlanFrom(derivation, configuration, {
		intent: { type: "sibling" },
		estimator: input.tokenEstimator,
	});
	return toCapturedGeneration(preparation, derivation, configuration, plan);
}

/** ==[HUMAN APPROVED]== Semantic counterparts used by Generation/inspection entry points. */
export function captureSendGenerationAsync(
	input: SendGenerationCaptureInput,
	captured?: SendGenerationCapture,
): SendGenerationCapture | Promise<SendGenerationCapture> {
	const initial = captured ?? captureSendGeneration(input);
	const { conversationId } = input;
	const content = initial.humanContent;
	const preparation = prepareGenerationInputsAsync({
		database: input.database,
		conversationId,
		kind: "send",
		content,
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
		embeddingFetch: input.embeddingFetch,
	}, initial.preparation);
	const complete = (preparation: GenerationPreparation): SendGenerationCapture => {
		if (preparation === initial.preparation) return initial;
		const { derivation } = preparation;
		const configuration = captureConfigurationFromPreparation(preparation);
		const reuseHumanMessageId = initial.reuseHumanMessageId;
		const submitted = reuseHumanMessageId === undefined
			? { ...derivation, context: [...derivation.context, { kind: "message" as const, speakerName: derivation.human.name, content, role: "human" as const }] }
			: derivation;
		const plan = compilePlanFrom(submitted, configuration, { estimator: input.tokenEstimator });
		return { ...toCapturedGeneration(preparation, derivation, configuration, plan), humanContent: content, reuseHumanMessageId };
	};
	return preparation instanceof Promise ? preparation.then(complete) : complete(preparation);
}

export function captureContinuationGenerationAsync(
	input: GenerationCaptureInput,
	captured?: ContinuationGenerationCapture,
): ContinuationGenerationCapture | Promise<ContinuationGenerationCapture> {
	const initial = captured ?? captureContinuationGeneration(input);
	const preparation = prepareGenerationInputsAsync({
		database: input.database,
		conversationId: input.conversationId,
		kind: "continuation",
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
		embeddingFetch: input.embeddingFetch,
	}, initial.preparation);
	const complete = (preparation: GenerationPreparation): ContinuationGenerationCapture => {
		if (preparation === initial.preparation) return initial;
		const { derivation } = preparation;
		const latest = preparation.participation.messages.at(-1);
		const selected = latest?.variant;
		if (latest === undefined || selected === null || selected === undefined) throw new ContinuationUnavailableError("not-terminal-model-message");
		const configuration = captureConfigurationFromPreparation(preparation);
		if (configuration.settings.continuationStrategy !== "instruction" && selected.content.length === 0) {
			throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
		}
		const intent = continuationIntentFor(configuration.settings);
		const plan = compilePlanFrom(derivation, configuration, { intent, estimator: input.tokenEstimator });
		return {
			...toCapturedGeneration(preparation, derivation, configuration, plan),
			precedingMessageId: latest.id,
			precedingVariantId: selected.id,
			intent,
			assistantPrefill: configuration.settings.continuationStrategy === "assistant-prefill"
				? { prefix: selected.content, suffix: configuration.settings.continuationPrefillSuffix }
				: undefined,
		};
	};
	return preparation instanceof Promise ? preparation.then(complete) : complete(preparation);
}

export function captureSiblingGenerationAsync(
	input: SiblingGenerationCaptureInput,
	captured?: CapturedGeneration,
): CapturedGeneration | Promise<CapturedGeneration> {
	const initial = captured ?? captureSiblingGeneration(input);
	const preparation = prepareGenerationInputsAsync({
		database: input.database,
		conversationId: input.conversationId,
		kind: "sibling",
		messageId: input.messageId,
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
		embeddingFetch: input.embeddingFetch,
	}, initial.preparation);
	const complete = (preparation: GenerationPreparation): CapturedGeneration => {
		if (preparation === initial.preparation) return initial;
		const { derivation } = preparation;
		const configuration = captureConfigurationFromPreparation(preparation);
		const plan = compilePlanFrom(derivation, configuration, { intent: { type: "sibling" }, estimator: input.tokenEstimator });
		return toCapturedGeneration(preparation, derivation, configuration, plan);
	};
	return preparation instanceof Promise ? preparation.then(complete) : complete(preparation);
}
