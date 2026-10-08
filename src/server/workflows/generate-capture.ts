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
	type ConversationSummary,
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
	PromptPlan,
	TokenEstimator,
} from "../prompt-compiler";
import {
	connectionSnapshotOf,
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../connection-settings";
import {
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
	GenerationTargetFor,
	GenerationTargetKind,
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

interface GenerationDerivation {
	human: CastParticipantSnapshot;
	model: CastParticipantSnapshot;
	context: readonly PromptContextEntry[];
}

interface ParticipatingHistory {
	readonly messages: readonly ParticipatingHistoryMessage[];
	readonly control: ConversationSnapshot["control"];
}

type ParticipatingHistoryMessage = SelectedHistoryRead["messages"][number];

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

// ==[HUMAN APPROVED]== The lifecycle facts of one captured Generation, keyed by attempt
// kind: exactly the fields that kind's acceptance commands read, declared
// once and carried by both the preparation member and the captured
// Generation.
export type GenerationCaptureFacts<K extends GenerationTargetKind = GenerationTargetKind> = {
	send: { readonly reuseHumanMessageId: number | undefined };
	// ==[HUMAN APPROVED]== A Continuation always carries an intent: this fact narrows the
	// member's carried intent for the acceptance command. Sibling derives no
	// facts beyond its own target fields.
	continuation: {
		readonly precedingMessageId: number;
		readonly precedingVariantId: number;
		readonly intent: GenerationIntent;
	};
	sibling: {};
}[K];

// ==[HUMAN APPROVED]== The carried derivations every member states: the instant Memory
// Recall snapshot, the carried intent, and the pending-human decision.
type GenerationPreparationCarried = {
	readonly memory: MemoryRecallSnapshot;
	readonly intent: GenerationIntent | undefined;
	readonly pendingHumanText: string | undefined;
};

// ==[HUMAN APPROVED]== The one captured preparation member: the shared preparation base, the
// attempt's own target fields and lifecycle facts, and the carried derivations.
type GenerationPreparationMember<K extends GenerationTargetKind> =
	GenerationPreparationBase & GenerationTargetFor<K> & GenerationCaptureFacts<K> & GenerationPreparationCarried;

export type GenerationPreparationSnapshot<K extends GenerationTargetKind = GenerationTargetKind> = {
	send: GenerationPreparationMember<"send">;
	continuation: GenerationPreparationMember<"continuation">;
	sibling: GenerationPreparationMember<"sibling">;
}[K];

type GenerationPreparation<K extends GenerationTargetKind = GenerationTargetKind> = {
	send: Omit<GenerationPreparationSnapshot<"send">, "memory"> & { readonly memory: MemoryActivationRecord; readonly fingerprint: string };
	continuation: Omit<GenerationPreparationSnapshot<"continuation">, "memory"> & { readonly memory: MemoryActivationRecord; readonly fingerprint: string };
	sibling: Omit<GenerationPreparationSnapshot<"sibling">, "memory"> & { readonly memory: MemoryActivationRecord; readonly fingerprint: string };
}[K];

// ==[HUMAN APPROVED]== The kind-wide member projections the generic builders state as
// their ensured intermediates; the cast to the public per-kind member is
// the only kind claim they make.
type GenerationPreparationSnapshotAcrossKinds =
	GenerationPreparationBase & GenerationTargetFor<GenerationTargetKind> & GenerationCaptureFacts<GenerationTargetKind> & GenerationPreparationCarried;
type GenerationPreparationAcrossKinds =
	Omit<GenerationPreparationSnapshotAcrossKinds, "memory"> & {
		readonly memory: MemoryActivationRecord;
		readonly fingerprint: string;
	};

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

// ==[HUMAN APPROVED]== The intent one attempt kind carries, so the policy rows and the captured Generation read the same mapping.
type GenerationIntentFor<K extends GenerationTargetKind> = {
	send: undefined;
	continuation: GenerationIntent;
	sibling: GenerationIntent;
}[K];

// ==[HUMAN APPROVED]== The capture state the member fields read: the captured Control pair, the selected participation, the attempt's carried intent, and the Conversation's generation settings.
interface GenerationCaptureState<K extends GenerationTargetKind> {
	readonly participation: ParticipatingHistory;
	readonly human: CastParticipantSnapshot;
	readonly model: CastParticipantSnapshot;
	readonly intent: GenerationIntentFor<K>;
	readonly settings: ConversationGenerationSettings;
}

// ==[HUMAN APPROVED]== The one capture policy per attempt kind: the shared preparation and
// capture flows read these rows instead of branching on the kind, so the
// kinds differ only where they genuinely differ. Every row function reads
// only the attempt's target fields; the merged capture input carries them
// alongside the capture options.
interface GenerationCapturePolicy<K extends GenerationTargetKind> {
	// ==[HUMAN APPROVED]== The Message whose Variant is the attempt's read point in the selected history.
	readonly selectsMessageId?: (attempt: GenerationTargetFor<K>) => number;
	// ==[HUMAN APPROVED]== The kind's eligibility guard, thrown before any semantic work.
	readonly assertEligible?: (read: {
		readonly summary: ConversationSummary;
		readonly selected: SelectedHistoryRead;
		readonly conversationId: number;
	}) => void;
	// ==[HUMAN APPROVED]== The intent the attempt carries; effective settings and plan compilation read the same derivation.
	readonly intent: (settings: ConversationGenerationSettings) => GenerationIntentFor<K>;
	// ==[HUMAN APPROVED]== The attempt's member fields: its target fields plus lifecycle facts and the pending-human decision.
	readonly memberFields: (
		state: GenerationCaptureState<K>,
		attempt: GenerationTargetFor<K>,
	) => GenerationTargetFor<K> & GenerationCaptureFacts<K> & { readonly pendingHumanText: string | undefined };
	// ==[HUMAN APPROVED]== The human writing the asynchronous semantic pass scans with, ungated by reuse — behavior preserved from the F3 split.
	readonly semanticPendingHumanText?: (attempt: GenerationTargetFor<K>) => string | undefined;
}

// ==[HUMAN APPROVED]== The one capture policy table, one row per attempt kind.
type GenerationCapturePolicies = { [K in GenerationTargetKind]: GenerationCapturePolicy<K> };

const capturePolicies: GenerationCapturePolicies = {
	send: {
		intent: () => undefined,
		memberFields: (state, attempt) => {
			const reuseHumanMessageId = reusableHumanMessageId(state.participation.messages, state.human.id, attempt.content);
			return {
				kind: "send",
				content: attempt.content,
				reuseHumanMessageId,
				pendingHumanText: reuseHumanMessageId === undefined ? attempt.content : undefined,
			};
		},
		semanticPendingHumanText: (attempt) => attempt.content,
	},
	continuation: {
		assertEligible: ({ summary }) => {
			if (summary.activeGenerations.length > 0) throw new ContinuationUnavailableError("active-generation");
		},
		intent: (settings) => continuationIntentFor(settings),
		memberFields: (state) => {
			// ==[HUMAN APPROVED]== The one Continuation eligibility validation, at the point the
			// terminal entry is in hand and before the semantic memory pass.
			const latest = state.participation.messages.at(-1);
			const selectedVariant = latest?.variant;
			const latestWasModelAuthored = latest !== undefined &&
				roleForMessage(latest, state.human.id, state.model.id) === "model";
			const hasUsableOutput = selectedVariant !== null && selectedVariant !== undefined &&
				(selectedVariant.content.length > 0 || selectedVariant.data.some(
					(entry) => entry.namespace === "generation" && entry.key === "reasoning" && entry.value.length > 0,
				));
			if (latest === undefined || !latestWasModelAuthored || !hasUsableOutput) {
				throw new ContinuationUnavailableError("not-terminal-model-message");
			}
			if (state.settings.continuationStrategy === "assistant-prefill" && selectedVariant.content.length === 0) {
				throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
			}
			return {
				kind: "continuation", precedingMessageId: latest.id, precedingVariantId: selectedVariant.id, intent: state.intent, pendingHumanText: undefined,
			};
		},
	},
	sibling: {
		selectsMessageId: (attempt) => attempt.messageId,
		assertEligible: ({ summary, selected, conversationId }) => {
			const eligibility = deriveMessageSwipeEligibility(
				summary.playable,
				selected.target?.historicalContext ?? null,
				summary.cast.map((participant) => participant.id),
			);
			if (!eligibility.eligible) {
				if (eligibility.reason === "conversation-not-playable") throw new ConversationNotPlayableError(conversationId);
				throw new SiblingVariantUnavailableError(eligibility.reason);
			}
		},
		intent: () => ({ type: "sibling" }),
		memberFields: (state, attempt) => ({ kind: "sibling", messageId: attempt.messageId, pendingHumanText: undefined }),
	},
};

/** ==[HUMAN APPROVED]== The capture configuration every attempt states: the safe connection
 * identity, its settings seam, the initiating-client formatting context, the
 * optional embedding transport, and the project-owned token estimator. */
export interface GenerationCaptureOptions {
	readonly conversationId: number;
	readonly connection?: ModelClientConnectionSnapshot | null | undefined;
	readonly connectionSettings?: ConnectionSettingsModuleOptions | undefined;
	readonly tokenEstimator?: TokenEstimator | undefined;
	readonly formatting?: GenerationFormattingContext | undefined;
	/** ==[HUMAN APPROVED]== Test/control seam for the application-wide OpenAI-compatible embedding service. */
	readonly preparationFetch?: ModelFetch | undefined;
}

/** ==[HUMAN APPROVED]== The one preparation input: the focused Conversation seams' arguments and
 * the attempt's capture configuration around the one Generation Target. */
export type PrepareGenerationInputs<K extends GenerationTargetKind = GenerationTargetKind> = {
	readonly database: Database;
} & GenerationCaptureOptions & GenerationTargetFor<K>;

/** ==[HUMAN APPROVED]==
 * Read the deterministic inputs for one attempt through the focused Conversation seams. The
 * returned snapshot is safe to retain while the canonical async preparation completes semantic
 * evaluation: compilation and preview validation never reread mutable history or execute macros.
 */
export function prepareGenerationInputsSnapshot<K extends GenerationTargetKind>(
	input: PrepareGenerationInputs<K>,
): GenerationPreparationSnapshot<K> {
	const policy = capturePolicies[input.kind];
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
				targetMessageId: policy.selectsMessageId?.(input),
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
	policy.assertEligible?.({ summary, selected, conversationId: input.conversationId });
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
	const intent = policy.intent(settings);
	// ==[HUMAN APPROVED]== The attempt's member fields — its target fields plus lifecycle
	// facts and the pending-human decision — derived once where their reads
	// are validated.
	const memberFields = policy.memberFields({ participation, human, model, intent, settings }, input);
	const pendingHumanText = memberFields.pendingHumanText;
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
			role: roleForMessage(message, human.id, model.id),
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
	const member: GenerationPreparationSnapshotAcrossKinds = {
		...preparation,
		...memberFields,
		intent,
		pendingHumanText,
		memory: captureMemory(),
	};
	// ==[HUMAN APPROVED]== SAFETY: the member fields carry the attempt's own target fields
	// and lifecycle facts, so the assembled member is the public member of
	// the attempt's kind.
	return member as GenerationPreparationSnapshot<K>;
}

/** ==[HUMAN APPROVED]==
 * Capture the same immutable inputs as prepareGenerationInputsSnapshot, completing the one
 * asynchronous semantic pass before a Generation Plan is compiled. Every caller
 * receives a Promise, including the no-semantic-work path, so Send, Continuation,
 * Sibling, and inspected Prompt Plan preparation share one asynchronous seam.
 */
export async function prepareGenerationInputsAsync<K extends GenerationTargetKind>(
	input: PrepareGenerationInputs<K>,
): Promise<GenerationPreparation<K>> {
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
			pendingHumanText: capturePolicies[input.kind].semanticPendingHumanText?.(input),
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
	const ready: GenerationPreparationAcrossKinds = {
		...preparation,
		lore,
		memory,
		fingerprint: generationPreparationFingerprint(snapshot),
	};
	// ==[HUMAN APPROVED]== SAFETY: the prepared snapshot is this attempt's own member, so the
	// re-evaluated semantic pass and the completed Memory record are that
	// member's own fields under GenerationPreparation<K>.
	return ready as GenerationPreparation<K>;
}

const captureConfigurationFromPreparation = (
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

/**
 * ==[HUMAN APPROVED]== The shared Generation-start capture every lifecycle builds: the
 * complete compiled Generation Plan, the retained writing context, the Control
 * pair, the model author stamp, and the provenance capture. The lifecycle
 * facts of one kind ride on the same Generation Target union.
 */
interface CapturedGeneration {
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

/** ==[HUMAN APPROVED]== The captured Generation of one attempt kind: the shared projection plus
 * exactly the lifecycle facts that kind's acceptance commands read and the
 * attempt's carried intent. */
export type CapturedGenerationFor<K extends GenerationTargetKind = GenerationTargetKind> = {
	send: CapturedGeneration & GenerationTargetFor<"send"> & GenerationCaptureFacts<"send"> & { readonly intent: GenerationIntent | undefined };
	continuation: CapturedGeneration & GenerationTargetFor<"continuation"> & GenerationCaptureFacts<"continuation"> & { readonly intent: GenerationIntent | undefined };
	sibling: CapturedGeneration & GenerationTargetFor<"sibling"> & GenerationCaptureFacts<"sibling"> & { readonly intent: GenerationIntent | undefined };
}[K];

/**
 * ==[HUMAN APPROVED]== Project one captured Generation into the fields shared by every acceptance
 * command. Each lifecycle spreads this projection alongside its lifecycle-
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
		promptContext: capture.context,
		generationSettings: capture.plan.effectiveSettings,
		connection: connectionIdentityOf(capture.connection),
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

/** ==[HUMAN APPROVED]== Build the common provider-neutral request for an accepted Generation.
 * The assistant prefill of a Continuation is request intent, derived from the
 * compiled plan instead of retained separately: the compiler protects the
 * prefixed model entry for an assistant-prefill Continuation, so the plan's
 * final model history block is the prefix and the plan's own intent carries
 * the suffix. */
export function modelRequestFor(
	capture: CapturedGeneration,
	input: Pick<GenerationAttemptInput, "signal">,
): ModelClientGenerationInput {
	const continuationIntent = capture.plan.promptPlan.intent?.type === "continuation"
		? capture.plan.promptPlan.intent
		: undefined;
	return {
		promptPlan: capture.plan.promptPlan,
		modelId: capture.plan.effectiveSettings.modelId,
		generationSettings: projectModelClientGenerationSettings(capture.plan.effectiveSettings),
		connection: capture.connection,
		assistantPrefill: continuationIntent?.strategy === "assistant-prefill"
			? { prefix: finalModelHistoryContent(capture.plan.promptPlan), suffix: continuationIntent.suffix }
			: undefined,
		signal: input.signal,
	};
}

const finalModelHistoryContent = (plan: PromptPlan): string => {
	let content = "";
	for (const block of plan.blocks) {
		if (block.kind === "history" && block.role === "model") content = block.content;
	}
	return content;
};

/**
 * ==[HUMAN APPROVED]== Assemble the shared Generation-start capture: the complete compiled
 * Generation Plan, the retained writing context, the Control pair, the model
 * author stamp, and the provenance capture.
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

// ==[HUMAN APPROVED]== Active inspection keeps the exact budget decision made at Generation
// start, including the whole history entries omitted during preflight. The
// retained writing context and the Effective Generation Settings pass
// through as the closed JSON values they already are, and the connection
// identity projection strips the provider snapshot's runtime-only model
// list at the Conversation domain boundary. Inspection is deliberately not
// copied into terminal Variant provenance.
const promptInspectionJson = (budget: PromptBudgetResult): ConversationJsonValue => ({
	tokenEstimate: budget.tokenEstimate,
	responseBudget: budget.responseBudget,
	safetyAllowance: budget.safetyAllowance,
	contextLimit: budget.contextLimit,
	totalRequiredTokens: budget.totalRequiredTokens,
	omittedContext: budget.omittedContext,
});

/** ==[HUMAN APPROVED]==
 * Capture one Generation attempt: prepare the immutable inputs, compile the
 * one Generation Plan, and assemble the shared capture whose lifecycle facts
 * ride on the attempt's own target. The three former per-kind capture
 * functions were the same preparation, compilation, and assembly with the
 * target's kind selecting only the intent, the submitted-writing context, and
 * the acceptance facts.
 */
export async function captureGeneration<K extends GenerationTargetKind>(
	database: Database,
	target: GenerationTargetFor<K>,
	options: GenerationCaptureOptions,
): Promise<CapturedGenerationFor<K>> {
	const preparation = await prepareGenerationInputsAsync<K>({ database, ...target, ...options });
	const { derivation } = preparation;
	const configuration = captureConfigurationFromPreparation(preparation);
	// ==[HUMAN APPROVED]== A retry reuses the already accepted trailing human Message; a fresh
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
	const shared = toCapturedGeneration(preparation, derivation, configuration, plan);
	const captured: CapturedGenerationFor = { ...shared, ...preparation };
	// ==[HUMAN APPROVED]== SAFETY: the attempt's target and its preparation carry the same kind
	// by construction (the preparation is captured from that target), so the
	// spread's member fields and facts are the CapturedGenerationFor<K>
	// member's own — the Continuation's carried intent is always defined.
	return captured as CapturedGenerationFor<K>;
}
