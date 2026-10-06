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
import { captureMemoryRecallSnapshot, evaluateMemoryRecallSnapshot, type MemoryRecallSnapshot } from "../memory/recall";
import type { MemoryActivationRecord } from "../../shared/contract/memory-recall";
import { promptImageResolutionFor } from "./prompt-image-resolution";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { generationRuntimeFor } from "./generation-runtime";
import { createMemorySettingsModule } from "../memory/settings";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { runConversationReadTransaction } from "../conversation/commands/transaction";
import {
	compileGenerationPlan,
	continuationIntentFor,
	effectiveGenerationSettingsFor,
	type EffectiveGenerationSettings,
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
import { hasEnabledLoreSlot, hasEnabledMemorySlot } from "../../shared/contract/prompt-preset";
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
		connection: ModelClientConnectionSnapshot | null;
		lore: ScopedLoreEvaluation;
		memory: MemoryActivationRecord;
	},
	options: {
		intent?: GenerationIntent | undefined;
		estimator?: TokenEstimator | undefined;
		database: Database;
	},
): GenerationPlan => {
	const compiled = compileGenerationPlan({
		human: toCompilerDefinition(derivation.human),
		model: toCompilerDefinition(derivation.model),
		context: derivation.context,
		recipe: configuration.slots,
		lore: configuration.lore.candidates,
		loreAllowance: configuration.lore.allowance,
		loreActivation: configuration.lore.activation,
		memoryActivation: configuration.memory,
		attempt: configuration.attempt,
		intent: options.intent,
		settings: configuration.settings,
		connection: configuration.connection === null ? null : {
			apiFormat: configuration.connection.apiFormat,
		},
		estimator: options.estimator,
		images: promptImageResolutionFor(options.database, configuration.connection, configuration.settings),
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
	memory: MemoryActivationRecord;
}

interface GenerationPreparationBase {
	readonly conversationId: number;
	readonly semanticTriggerRevision: number;
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

type PreparationKind =
	| { readonly kind: "send"; readonly content: string }
	| { readonly kind: "continuation" }
	| { readonly kind: "sibling"; readonly messageId: number };

export type GenerationPreparationSnapshot = GenerationPreparationBase & PreparationKind & { readonly memory: MemoryRecallSnapshot };

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

export type GenerationPreparation = GenerationPreparationBase & PreparationKind & {
	readonly memory: MemoryActivationRecord;
	readonly fingerprint: string;
};

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
	readonly preparationFetch?: ModelFetch;
}

export type PrepareGenerationInputs = PrepareGenerationInputsBase & (
	| { readonly kind: "send"; readonly content: string }
	| { readonly kind: "continuation" }
	| { readonly kind: "sibling"; readonly messageId: number }
);

/** ==[HUMAN APPROVED]==
 * Read the deterministic inputs for one attempt through the focused Conversation seams. The
 * returned snapshot is safe to retain while the canonical async preparation completes semantic
 * evaluation: compilation and preview validation never reread mutable history or execute macros.
 */
export function prepareGenerationInputsSnapshot(
	input: PrepareGenerationInputs,
): GenerationPreparationSnapshot {
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
	const lore = hasEnabledLoreSlot(recipe.slots)
		? evaluateScopedLore({
			database: input.database,
			conversationId: input.conversationId,
			messages: participation.messages.flatMap((message) => message.variant === null ? [] : [{ id: message.id, content: message.variant.content }]),
			pendingHumanText: input.kind === "send" && reuseHumanMessageId === undefined ? input.content : undefined,
			connectionSettings: input.connectionSettings,
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
	const memoryEnabled = createMemorySettingsModule(input.database).get().enabled && hasEnabledMemorySlot(recipe.slots);
	const memory = captureMemoryRecallSnapshot({
		database: input.database,
		conversationId: input.conversationId,
		enabled: memoryEnabled,
		messages: participation.messages.flatMap((message) => message.variant === null ? [] : [{
			messageId: message.id,
			variantId: message.variant.id,
			position: message.position,
			speakerName: message.author?.capturedName ?? null,
			role: roleForMessage(message, human.id, model.id),
			content: message.variant.content,
		}]),
		pendingHumanText: input.kind === "send" ? input.content : undefined,
		humanName: human.name,
	});
	const preparation = {
		conversationId: input.conversationId,
		semanticTriggerRevision: createSemanticTriggerSettingsModule(input.database).get().revision,
		formatting,
		derivation,
		participation,
		settings,
		effectiveSettings,
		recipe,
		connection,
		macroState,
		lore,
		memory,
	};
	if (input.kind === "send") return { ...preparation, kind: input.kind, content: input.content };
	if (input.kind === "sibling") return { ...preparation, kind: input.kind, messageId: input.messageId };
	return { ...preparation, kind: input.kind };
}

/** ==[HUMAN APPROVED]==
 * Capture the same immutable inputs as prepareGenerationInputsSnapshot, completing the one
 * asynchronous semantic pass before a Generation Plan is compiled. Every caller
 * receives a Promise, including the no-semantic-work path, so Send, Continuation,
 * Sibling, and inspected Prompt Plan preparation share one asynchronous seam.
 */
export async function prepareGenerationInputsAsync(
	input: PrepareGenerationInputs,
): Promise<GenerationPreparation> {
	const signal = generationRuntimeFor(input.database).shutdownSignal;
	signal.throwIfAborted();
	// ==[HUMAN APPROVED]== The snapshot is captured before semantic work can suspend, so books,
	// attachments, history, settings, and participant data remain the exact values observed at
	// generation start.
	const snapshot = prepareGenerationInputsSnapshot(input);
	const { memory: memorySnapshot, ...preparation } = snapshot;
	const needsSemantic = hasEnabledLoreSlot(preparation.recipe.slots) &&
		preparation.lore.activation.mode === "keyword-fallback";
	const lorePromise = needsSemantic
		? evaluateScopedLoreAsync({
			database: input.database,
			conversationId: preparation.conversationId,
			messages: preparation.participation.messages.flatMap((message) => message.variant === null ? [] : [{ id: message.id, content: message.variant.content }]),
			pendingHumanText: preparation.kind === "send" ? preparation.content : undefined,
			fetch: input.preparationFetch,
			signal,
		}, preparation.lore.sources)
		: Promise.resolve(preparation.lore);
	const memoryPromise = evaluateMemoryRecallSnapshot({ database: input.database, snapshot: memorySnapshot, fetch: input.preparationFetch, signal }).catch((error) => {
		signal.throwIfAborted();
		throw new InvalidConversationCommandError(`Memory recall failed: ${error instanceof Error ? error.message : "Retry preparation or disable Memory."}`);
	});
	const [lore, memory] = await Promise.all([lorePromise, memoryPromise]);
	signal.throwIfAborted();
	return { ...preparation, lore, memory, fingerprint: generationPreparationFingerprint(snapshot) };
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
		memory: preparation.memory,
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
		repeatedImagePlacement: plan.effectiveSettings.repeatedImagePlacement,
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
		memoryActivation: capture.plan.memoryActivation,
		provenance: capture.provenance,
		macroPresetId: capture.macroPresetId,
		macroWrites: capture.macroWrites,
	} satisfies Pick<
		AcceptTailGenerationInput,
		"conversationId" | "timestamp" | "humanParticipantId" | "modelParticipantId" |
		"capturedHumanName" | "capturedModelName" | "promptPlan" | "promptInspection" |
		"promptContext" | "generationSettings" | "connection" | "loreActivation" | "memoryActivation" | "provenance" |
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
export type PersistedGenerationSettings = {
	readonly [K in GenerationSettingsField]: ConversationJsonValue;
};

export function generationSettingsJson(
	effective: EffectiveGenerationSettings,
): PersistedGenerationSettings {
	return effective;
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
	preparationFetch?: ModelFetch | undefined;
}

export type SendGenerationCaptureInput = GenerationCaptureInput & { content: string };
export type SiblingGenerationCaptureInput = GenerationCaptureInput & { messageId: number };

// ==[HUMAN APPROVED]== Build the candidate Prompt Plan without writing it. A retry reuses the
// already accepted trailing human Message; a fresh Send appends the submitted
// human writing to the selected narrative path before budgeting.
export interface ContinuationGenerationCapture extends CapturedGeneration {
	precedingMessageId: number;
	precedingVariantId: number;
	intent: GenerationIntent;
	assistantPrefill?: AssistantPrefill;
}

/** ==[HUMAN APPROVED]== Semantic counterparts used by Generation/inspection entry points. */
export async function captureSendGenerationAsync(
	input: SendGenerationCaptureInput,
): Promise<SendGenerationCapture> {
	const { conversationId } = input;
	const content = input.content;
	const preparation = await prepareGenerationInputsAsync({
		database: input.database,
		conversationId,
		kind: "send",
		content,
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
		preparationFetch: input.preparationFetch,
	});
	const { derivation } = preparation;
	const configuration = captureConfigurationFromPreparation(preparation);
	const reuseHumanMessageId = sendReuseTargetOf(preparation)?.messageId;
	const submitted = reuseHumanMessageId === undefined
		? { ...derivation, context: [...derivation.context, { kind: "message" as const, speakerName: derivation.human.name, content, role: "human" as const }] }
		: derivation;
	const plan = compilePlanFrom(submitted, configuration, { estimator: input.tokenEstimator, database: input.database });
	return { ...toCapturedGeneration(preparation, derivation, configuration, plan), humanContent: content, reuseHumanMessageId };
}

export async function captureContinuationGenerationAsync(
	input: GenerationCaptureInput,
): Promise<ContinuationGenerationCapture> {
	const preparation = await prepareGenerationInputsAsync({
		database: input.database,
		conversationId: input.conversationId,
		kind: "continuation",
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
		preparationFetch: input.preparationFetch,
	});
	const { derivation } = preparation;
	const latest = preparation.participation.messages.at(-1);
	const selected = latest?.variant;
	if (latest === undefined || selected === null || selected === undefined) throw new ContinuationUnavailableError("not-terminal-model-message");
	const configuration = captureConfigurationFromPreparation(preparation);
	if (configuration.settings.continuationStrategy !== "instruction" && selected.content.length === 0) {
		throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
	}
	const intent = continuationIntentFor(configuration.settings);
	const plan = compilePlanFrom(derivation, configuration, { intent, estimator: input.tokenEstimator, database: input.database });
	return {
		...toCapturedGeneration(preparation, derivation, configuration, plan),
		precedingMessageId: latest.id,
		precedingVariantId: selected.id,
		intent,
		assistantPrefill: configuration.settings.continuationStrategy === "assistant-prefill"
			? { prefix: selected.content, suffix: configuration.settings.continuationPrefillSuffix }
			: undefined,
	};
}

export async function captureSiblingGenerationAsync(
	input: SiblingGenerationCaptureInput,
): Promise<CapturedGeneration> {
	const preparation = await prepareGenerationInputsAsync({
		database: input.database,
		conversationId: input.conversationId,
		kind: "sibling",
		messageId: input.messageId,
		connection: input.connection,
		connectionSettings: input.connectionSettings,
		formatting: input.formatting,
		preparationFetch: input.preparationFetch,
	});
	const { derivation } = preparation;
	const configuration = captureConfigurationFromPreparation(preparation);
	const plan = compilePlanFrom(derivation, configuration, { intent: { type: "sibling" }, estimator: input.tokenEstimator, database: input.database });
	return toCapturedGeneration(preparation, derivation, configuration, plan);
}
