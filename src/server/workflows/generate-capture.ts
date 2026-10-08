import { generationProvenanceEntry } from "./generate-capture-projections";
export { capturedAcceptanceFields, modelRequestFor } from "./generate-capture-projections";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import {
	authorRoleOf,
	continuationEligibility,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	ContinuationUnavailableError,
	deriveMessageSwipeEligibility,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	type ConversationDataEntry,
	type ConversationSummary,
} from "../conversation";
import type { ConversationGenerationSettings } from "../conversation";
import { readConversationPromptPresetRecipeFromConnection } from "../prompt-preset";
import type { PromptPresetRecipe, PromptPresetSlot } from "../prompt-preset";
import { evaluateScopedLore, evaluateScopedLoreAsync, noLoreEvaluation, type ScopedLoreEvaluation } from "../lorebook/evaluation";
import type { CastParticipantSnapshot } from "../conversation";
import { readConversationSummaryFromConnection } from "../conversation";
import { readConversationGenerationSettingsFromConnection } from "../conversation";
import { readSelectedHistoryFromConnection } from "../conversation";
import { captureMemoryRecallSnapshot, evaluateMemoryRecallSnapshot, type MemoryRecallSnapshot } from "../memory/recall";
import type { MemoryActivationRecord } from "../../shared/contract/memory-recall";
import { promptImageResolutionFor } from "./prompt-image-resolution";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { generationRuntimeFor } from "./generation-runtime";
import { createMemorySettingsModule } from "../memory/settings";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { runConversationReadTransaction } from "../conversation";
import {
	compileGenerationPlan,
	continuationIntentFor,
	effectiveGenerationSettingsFor,
	type EffectiveGenerationSettings,
	type GenerationPlan,
} from "../generation-plan";
import type {
	GenerationIntent,
	PromptContextEntry,
	TokenEstimator,
} from "../prompt-compiler";
import {
	type ConnectionSettingsModuleOptions,
} from "../connection-settings";
import {
	type ModelClientConnectionSnapshot,
} from "../model-client";
import type { ModelFetch } from "../model-client/types";
import { hasEnabledLoreSlot, hasEnabledMemorySlot } from "../../shared/contract/prompt-preset";
import {
	createAttemptEnvironment,
	type AttemptEnvironment,
} from "../../shared/prompt-macro-engine";
import {
	conversationGenerationSettings,
	type GenerationFormattingContext,
} from "../../shared/contract/conversation-schema";
import type {
	GenerationTarget,
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

// @approved
//  Generation-start capture: from one authoritative Conversation preparation and
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

interface ParticipatingHistory {
	readonly messages: readonly ParticipatingHistoryMessage[];
	readonly control: ConversationSummary["control"];
}

type ParticipatingHistoryMessage = SelectedHistoryRead["messages"][number];

const participatingHistoryFromRead = (
	read: SelectedHistoryRead,
	control: ConversationSummary["control"],
): ParticipatingHistory => ({
	messages: read.messages,
	control,
});

// @approved
//  Selected-history entries for prompt compilation, derived from each
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
			role: authorRoleOf(message, { humanParticipantId, modelParticipantId }),
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
const compilePlanFrom = (
	derivation: GenerationDerivation,
	configuration: {
		authorNote: string;
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
		authorNote: configuration.authorNote,
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

interface AttemptConfiguration {
	authorNote: string;
	settings: ConversationGenerationSettings;
	slots: readonly PromptPresetSlot[];
	promptPresetId: number;
	attempt: AttemptEnvironment;
	connection: ModelClientConnectionSnapshot | null;
	lore: ScopedLoreEvaluation;
	memory: MemoryActivationRecord;
}

interface GenerationPreparationBase {
	readonly authorNote: string;
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

export type GenerationCaptureFacts =
	| { readonly kind: "send"; readonly reuseHumanMessageId: number | undefined }
	| { readonly kind: "continuation"; readonly precedingMessageId: number; readonly precedingVariantId: number; readonly intent: GenerationIntent }
	| { readonly kind: "sibling" };

interface PreparationFields extends GenerationPreparationBase {
	readonly target: GenerationTarget;
	readonly facts: GenerationCaptureFacts;
	readonly intent: GenerationIntent | undefined;
	readonly pendingHumanText: string | undefined;
}

export interface PreparationSnapshot extends PreparationFields {
	readonly memory: MemoryRecallSnapshot;
}

export interface Preparation extends PreparationFields {
	readonly memory: MemoryActivationRecord;
	readonly fingerprint: string;
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

function captureFacts(
	target: GenerationTarget,
	participation: ParticipatingHistory,
	human: CastParticipantSnapshot,
	model: CastParticipantSnapshot,
	settings: ConversationGenerationSettings,
): GenerationCaptureFacts {
	switch (target.kind) {
		case "send": return { kind: "send", reuseHumanMessageId: reusableHumanMessageId(participation.messages, human.id, target.content) };
		case "sibling": return { kind: "sibling" };
		case "continuation": {
			const latest = participation.messages.at(-1);
			const variant = latest?.variant;
			if (latest === undefined || variant === null || variant === undefined) throw new ContinuationUnavailableError("not-terminal-model-message");
			const reason = continuationEligibility({
				authorRole: authorRoleOf(latest, { humanParticipantId: human.id, modelParticipantId: model.id }),
				content: variant.content,
				hasReasoning: variant.data.some((entry) => entry.namespace === "generation" && entry.key === "reasoning" && entry.value.length > 0),
			}, settings.continuationStrategy);
			if (reason !== null) throw new ContinuationUnavailableError(reason);
			return { kind: "continuation", precedingMessageId: latest.id, precedingVariantId: variant.id, intent: continuationIntentFor(settings) };
		}
	}
}

/** ==[HUMAN APPROVED]== The capture configuration every attempt states: the safe connection
 * identity, its settings seam, the initiating-client formatting context, the
 * optional embedding transport, and the project-owned token estimator. */
export interface GenerationCaptureOptions {
	readonly conversationId: number;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions | undefined;
	readonly tokenEstimator?: TokenEstimator | undefined;
	readonly formatting?: GenerationFormattingContext | undefined;
	/** ==[HUMAN APPROVED]== Test/control seam for the application-wide OpenAI-compatible embedding service. */
	readonly preparationFetch?: ModelFetch | undefined;
}

/** ==[HUMAN APPROVED]== The one preparation input: the focused Conversation seams' arguments and
 * the attempt's capture configuration around the one Generation Target. */
export interface PrepareGenerationInputs extends GenerationCaptureOptions {
	readonly database: Database;
	readonly target: GenerationTarget;
}

/** ==[HUMAN APPROVED]==
 * Read the deterministic inputs for one attempt through the focused Conversation seams. The
 * returned snapshot is safe to retain while the canonical async preparation completes semantic
 * evaluation: compilation and preview validation never reread mutable history or execute macros.
 */
export function prepareGenerationInputsSnapshot(
	input: PrepareGenerationInputs,
): PreparationSnapshot {
	const { target, connection } = input;
	const { summary, recipe, settings, selected } = runConversationReadTransaction(
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
				targetMessageId: target.kind === "sibling" ? target.messageId : undefined,
				conversationDataNamespace: MACRO_DATA_NAMESPACE,
				conversationDataKeyPrefix: macroInitialValuePrefix(recipe.id),
				variantDataKeys: [macroWritesKey(recipe.id), "reasoning"],
			});
			if (selected === undefined) throw new ConversationNotFoundError(input.conversationId);
			return { summary, recipe, settings, selected };
		},
	);
	if (!Value.Check(conversationGenerationSettings, settings)) {
		throw new Error("Conversation Generation Settings are corrupt.");
	}
	if (target.kind === "continuation" && summary.activeGenerations.length > 0) throw new ContinuationUnavailableError("active-generation");
	if (target.kind === "sibling") {
		const eligibility = deriveMessageSwipeEligibility(summary.playable, selected.target?.historicalContext ?? null, summary.cast.map((participant) => participant.id));
		if (!eligibility.eligible) {
			if (eligibility.reason === "conversation-not-playable") throw new ConversationNotPlayableError(input.conversationId);
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
	const facts = captureFacts(target, participation, human, model, settings);
	const intent = facts.kind === "continuation" ? facts.intent : target.kind === "sibling" ? { type: "sibling" as const } : undefined;
	const pendingHumanText = target.kind === "send" && facts.kind === "send" && facts.reuseHumanMessageId === undefined ? target.content : undefined;
	const lore = hasEnabledLoreSlot(recipe.slots)
		? evaluateScopedLore({
			database: input.database,
			conversationId: input.conversationId,
			messages: participation.messages.flatMap((message) => message.variant === null ? [] : [{ id: message.id, content: message.variant.content }]),
			pendingHumanText,
			connectionSettings: input.connectionSettings,
		})
		: noLoreEvaluation();
	const effectiveSettings = effectiveGenerationSettingsFor(settings, intent, connection);
	const macroState = new Map(deriveMacroState({
		initialData: selected.initialData,
		presetId: recipe.id,
		selectedVariants: participation.messages.map((message) => ({
			selected: message.variant !== null,
			data: message.variant?.data ?? [],
		})),
	}));
	const memoryEnabled = createMemorySettingsModule(input.database).get().enabled && hasEnabledMemorySlot(recipe.slots);
	const captureMemory = () => captureMemoryRecallSnapshot({
		database: input.database,
		conversationId: input.conversationId,
		enabled: memoryEnabled,
		messages: participation.messages.flatMap((message) => message.variant === null ? [] : [{
			messageId: message.id,
			variantId: message.variant.id,
			position: message.position,
			speakerName: message.author?.capturedName ?? null,
			role: authorRoleOf(message, { humanParticipantId: human.id, modelParticipantId: model.id }),
			content: message.variant.content,
		}]),
		pendingHumanText,
		humanName: human.name,
	});
	const preparation = {
		conversationId: input.conversationId,
		authorNote: summary.authorNote,
		semanticTriggerRevision: createSemanticTriggerSettingsModule(input.database).get().revision,
		formatting: {
			timeZone: input.formatting?.timeZone,
			locale: input.formatting?.locale,
		},
		derivation,
		participation,
		settings,
		effectiveSettings,
		recipe,
		connection,
		macroState,
		lore,
	};
	return { ...preparation, target, facts, intent, pendingHumanText, memory: captureMemory() };
}

/** ==[HUMAN APPROVED]==
 * Capture the same immutable inputs as prepareGenerationInputsSnapshot, completing the one
 * asynchronous semantic pass before a Generation Plan is compiled. Every caller
 * receives a Promise, including the no-semantic-work path, so Send, Continuation,
 * Sibling, and inspected Prompt Plan preparation share one asynchronous seam.
 */
export async function prepareGenerationInputsAsync(
	input: PrepareGenerationInputs,
): Promise<Preparation> {
	const signal = generationRuntimeFor(input.database).shutdownSignal;
	signal.throwIfAborted();
	// @approved
	//  The snapshot is captured before semantic work can suspend, so books,
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
			pendingHumanText: input.target.kind === "send" ? input.target.content : undefined,
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
	const ready: Preparation = {
		...preparation,
		lore,
		memory,
		fingerprint: generationPreparationFingerprint(snapshot),
	};
	return ready;
}

const captureConfigurationFromPreparation = (
	preparation: Preparation,
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
		authorNote: preparation.authorNote,
		settings: preparation.settings,
		slots: preparation.recipe.slots,
		promptPresetId: preparation.recipe.id,
		attempt,
		connection: preparation.connection,
		lore: preparation.lore,
		memory: preparation.memory,
	};
};

// @approved
//  The retained provenance record: safe connection identity, model identity,
// and the attempt's Effective Generation Settings. Only fields in the shared
// provenance vocabulary are retained — an intent-inapplicable Continuation
// operand is already absent from the plan — and Request Overrides are never
// retained.
/**
 * ==[HUMAN APPROVED]== The shared Generation-start capture every lifecycle builds: the
 * complete compiled Generation Plan, the retained writing context, the Control
 * pair, the model author stamp, and the provenance capture. The lifecycle
 * facts of one kind ride on the same Generation Target union.
 */
export interface CapturedGeneration {
	readonly target: GenerationTarget;
	readonly facts: GenerationCaptureFacts;
	readonly intent: GenerationIntent | undefined;
	readonly preparation: Preparation;
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
 * ==[HUMAN APPROVED]== Assemble the shared Generation-start capture: the complete compiled
 * Generation Plan, the retained writing context, the Control pair, the model
 * author stamp, and the provenance capture.
 */
const toCapturedGeneration = (
	preparation: Preparation,
	derivation: GenerationDerivation,
	configuration: AttemptConfiguration,
	plan: GenerationPlan,
): CapturedGeneration => ({
	target: preparation.target,
	facts: preparation.facts,
	intent: preparation.intent,
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

/** ==[HUMAN APPROVED]==
 * Capture one Generation attempt: prepare the immutable inputs, compile the
 * one Generation Plan, and assemble the shared capture whose lifecycle facts
 * ride on the attempt's own target. The three former per-kind capture
 * functions were the same preparation, compilation, and assembly with the
 * target's kind selecting only the intent, the submitted-writing context, and
 * the acceptance facts.
 */
export async function captureGeneration(
	database: Database,
	target: GenerationTarget,
	options: GenerationCaptureOptions,
): Promise<CapturedGeneration> {
	const preparation = await prepareGenerationInputsAsync({ database, target, ...options });
	const { derivation } = preparation;
	const configuration = captureConfigurationFromPreparation(preparation);
	// @approved
	//  A retry reuses the already accepted trailing human Message; a fresh
	// Send appends the submitted human writing to the selected narrative path
	// before budgeting. Continuation and Sibling compile the selected history
	// as captured.
	const context = preparation.pendingHumanText === undefined
		? derivation.context
		: [...derivation.context, { kind: "message" as const, speakerName: derivation.human.name, content: preparation.pendingHumanText, role: "human" as const }];
	const plan = compilePlanFrom({ ...derivation, context }, configuration, {
		intent: preparation.intent,
		estimator: options.tokenEstimator,
		database,
	});
	return toCapturedGeneration(preparation, derivation, configuration, plan);
}
