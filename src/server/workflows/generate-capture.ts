import type { BoxRecords } from "../../shared/contract/box-generation";
import { newVariantSeed, variantSeedOf } from "../box/seed";
import { readVariantSeeds } from "../box/records";
import { MACRO_DATA_NAMESPACE } from "../../shared/variant-data-codecs";
import { generationProvenanceEntry } from "./generate-capture-projections";
export { capturedAcceptanceFields, modelRequestFor } from "./generate-capture-projections";
import type { Database } from "bun:sqlite";
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
import { readVariantData, type VariantDataRecords } from "../conversation";
import { promptImageResolutionFor } from "./prompt-image-resolution";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { generationRuntimeFor } from "./generation-runtime";
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
import { hasEnabledLoreSlot } from "../../shared/contract/prompt-preset";
import {
	createAttemptEnvironment,
	type AttemptEnvironment,
} from "../../shared/prompt-macro-engine";
import {
	type GenerationFormattingContext,
} from "../../shared/contract/conversation-schema";
import type {
	GenerationTarget,
} from "../../shared/contract/conversation-schema";
import type { MacroVariableWrite } from "../../shared/contract/macro-variables";
import { deriveMacroState, macroInitialValuePrefix } from "../prompt-macros";
import type { MacroValue } from "../../shared/contract/macro-variable-write";
import type { SelectedHistoryRead } from "../conversation";
import { boxServices } from "../box/services";
import { advanceBoxes, captureBoxes, participatingBoxes, type BoxResults, type BoxInputs } from "../box/registry";
import { foldRecordStates } from "../box/records";
import { humanMessageText, readMessageMoves } from "../box/moves";
import { boxMovesError, sameMoves, type BoxMoves } from "../../shared/contract/box-generation";
import { readBoxLifecycles } from "../box/setup";

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

/** @approved
 * The one Generation Plan compilation. Every attempt and read-only
 * inspection compiles the same way from a derived Control pair, its ordered
 * writing context, and the captured configuration; only the Generation intent
 * and the estimator differ, so those are the only arguments a call site
 * states.
 */
const compilePlanFrom = (
	derivation: GenerationDerivation,
	configuration: {
		boxes: BoxResults;
		settings: ConversationGenerationSettings;
		slots: readonly PromptPresetSlot[];
		attempt: AttemptEnvironment;
		connection: ModelClientConnectionSnapshot | null;
		lore: ScopedLoreEvaluation;
	},
	options: {
		intent?: GenerationIntent | undefined;
		estimator?: TokenEstimator | undefined;
		database: Database;
	},
): GenerationPlan => {
	const compiled = compileGenerationPlan({
		boxes: configuration.boxes,
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
	boxes: BoxResults;
	settings: ConversationGenerationSettings;
	slots: readonly PromptPresetSlot[];
	promptPresetId: number;
	attempt: AttemptEnvironment;
	connection: ModelClientConnectionSnapshot | null;
	lore: ScopedLoreEvaluation;
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

export type GenerationCaptureFacts =
	| { readonly kind: "send"; readonly reuseHumanMessageId: number | undefined }
	| { readonly kind: "continuation"; readonly precedingMessageId: number; readonly precedingVariantId: number; readonly intent: GenerationIntent }
	| { readonly kind: "sibling" };

interface PreparationFields extends GenerationPreparationBase {
	readonly seed: string;
	readonly target: GenerationTarget;
	readonly facts: GenerationCaptureFacts;
	readonly intent: GenerationIntent | undefined;
	readonly pendingHumanText: string | undefined;
	/** @approved Selected history as Lore scans it, each Message's Moves rendered as the model reads them. */
	readonly scanMessages: readonly { readonly id: number; readonly content: string }[];
}

export interface PreparationSnapshot extends PreparationFields {
	readonly boxes: BoxInputs;
}

export interface Preparation extends PreparationFields {
	readonly boxes: BoxResults;
	readonly boxRecords: BoxRecords;
	readonly fingerprint: string;
}

const reusableHumanMessageId = (
	messages: readonly ParticipatingHistoryMessage[],
	humanParticipantId: number,
	target: { readonly content: string; readonly moves?: BoxMoves | undefined },
	moves: ReadonlyMap<number, BoxMoves>,
): number | undefined => {
	const latest = messages.at(-1);
	const variant = latest?.variant;
	return latest !== undefined &&
		variant !== null &&
		variant !== undefined &&
		latest.author?.participantId === humanParticipantId &&
		variant.content === target.content &&
		sameMoves(moves.get(latest.id), target.moves)
		? latest.id
		: undefined;
};

function captureFacts(
	target: GenerationTarget,
	participation: ParticipatingHistory,
	human: CastParticipantSnapshot,
	model: CastParticipantSnapshot,
	settings: ConversationGenerationSettings,
	variantData: ReadonlyMap<number, VariantDataRecords>,
	moves: ReadonlyMap<number, BoxMoves>,
): GenerationCaptureFacts {
	switch (target.kind) {
		case "send": return { kind: "send", reuseHumanMessageId: reusableHumanMessageId(participation.messages, human.id, target, moves) };
		case "sibling": return { kind: "sibling" };
		case "continuation": {
			const latest = participation.messages.at(-1);
			const variant = latest?.variant;
			if (latest === undefined || variant === null || variant === undefined) throw new ContinuationUnavailableError("not-terminal-model-message");
			const reason = continuationEligibility({
				authorRole: authorRoleOf(latest, { humanParticipantId: human.id, modelParticipantId: model.id }),
				content: variant.content,
				hasReasoning: (variantData.get(variant.id)?.reasoning?.length ?? 0) > 0,
			}, settings.continuationStrategy);
			if (reason !== null) throw new ContinuationUnavailableError(reason);
			return { kind: "continuation", precedingMessageId: latest.id, precedingVariantId: variant.id, intent: continuationIntentFor(settings) };
		}
	}
}

/** @approved The capture configuration every attempt states: the safe connection
 * identity, its settings seam, the initiating-client formatting context, the
 * optional embedding transport, and the project-owned token estimator. */
export interface GenerationCaptureOptions {
	readonly conversationId: number;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly connectionSettings?: ConnectionSettingsModuleOptions | undefined;
	readonly tokenEstimator?: TokenEstimator | undefined;
	readonly formatting?: GenerationFormattingContext | undefined;
	/** @approved Test/control seam for the application-wide OpenAI-compatible embedding service. */
	readonly preparationFetch?: ModelFetch | undefined;
}

/** @approved The one preparation input: the focused Conversation seams' arguments and
 * the attempt's capture configuration around the one Generation Target. */
export interface PrepareGenerationInputs extends GenerationCaptureOptions {
	readonly database: Database;
	readonly target: GenerationTarget;
	readonly seed?: string | undefined;
}

/** @approved
 * Read the deterministic inputs for one attempt through the focused Conversation seams. The
 * returned snapshot is safe to retain while the canonical async preparation completes semantic
 * evaluation: compilation and preview validation never reread mutable history or execute macros.
 */
export function prepareGenerationInputsSnapshot(
	input: PrepareGenerationInputs,
): PreparationSnapshot {
	const { target, connection } = input;
	const { summary, recipe, settings, selected, variantData, recordStates, boxes, siblingSeed, messageMoves } = runConversationReadTransaction(
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
			});
			if (selected === undefined) throw new ConversationNotFoundError(input.conversationId);
			const variantIds = selected.messages.flatMap((message) => message.variant === null ? [] : [message.variant.id]);
			const siblingId = selected.target?.variant?.id;
			const boxLifecycles = readBoxLifecycles(db, input.conversationId);
			const boxes = participatingBoxes(recipe.slots, boxLifecycles);
			return { boxes, summary, recipe, settings, selected,
				siblingSeed: siblingId === undefined ? undefined : variantSeedOf(readVariantSeeds(db, [siblingId]).get(siblingId), siblingId),
				variantData: readVariantData(db, variantIds, ["reasoning", "macroWrites"]), recordStates: foldRecordStates(db, variantIds, summary.boxSetups, boxes),
				messageMoves: readMessageMoves(db, selected.messages.map(({ id }) => id)) };
		},
	);
	if (target.kind === "continuation" && summary.activeGenerations.length > 0) throw new ContinuationUnavailableError("active-generation");
	if (target.kind === "sibling") {
		const eligibility = deriveMessageSwipeEligibility(summary.playable, selected.target?.historicalContext ?? null, summary.cast.map((participant) => participant.id));
		if (!eligibility.eligible) {
			if (eligibility.reason === "conversation-not-playable") throw new ConversationNotPlayableError(input.conversationId);
			throw new SiblingVariantUnavailableError(eligibility.reason);
		}
	}
	const participation: ParticipatingHistory = {
		messages: selected.messages,
		control: {
			humanParticipantId: selected.target?.historicalContext?.humanParticipantId
				?? summary.control.humanParticipantId,
			modelParticipantId: selected.target?.historicalContext?.modelParticipantId
				?? summary.control.modelParticipantId,
		},
	};
	const human = summary.cast.find((participant) =>
		participant.id === participation.control.humanParticipantId);
	const model = summary.cast.find((participant) =>
		participant.id === participation.control.modelParticipantId);
	if (human === undefined || model === undefined || human.id === model.id) {
		throw new ConversationNotPlayableError(input.conversationId);
	}
	// @approved
	//  The selected Messages as the model reads them, each Message's Moves
	// rendered before its prose: prompt history, Lore scanning and each
	// Box's capture all read this one projection.
	const rendered = participation.messages.flatMap((message) => message.variant === null ? [] : [{
		message,
		variantId: message.variant.id,
		prose: message.variant.content,
		speakerName: message.author?.capturedName ?? null,
		role: authorRoleOf(message, { humanParticipantId: human.id, modelParticipantId: model.id }),
		content: humanMessageText(messageMoves.get(message.id) ?? {}, message.variant.content, message.author?.capturedName ?? null, summary.boxes),
	}]);
	const derivation: GenerationDerivation = {
		human,
		model,
		context: rendered.map(({ speakerName, content, role }) => ({ kind: "message", speakerName, content, role })),
	};
	const facts = captureFacts(target, participation, human, model, settings, variantData, messageMoves);
	// @approved
	//  Only an enabled Box accepts newly staged Moves; a resent Message keeps the Moves it already carries.
	const staged = target.kind === "send" ? target.moves : undefined;
	const invalid = staged === undefined ? undefined : boxMovesError(staged);
	if (invalid !== undefined) throw new InvalidConversationCommandError(invalid);
	const closed = target.kind === "send" && facts.kind === "send" && facts.reuseHumanMessageId === undefined
		? Object.keys(staged ?? {}).find((id) => summary.boxes[id] !== "enabled") : undefined;
	if (closed !== undefined) throw new InvalidConversationCommandError(`The ${closed} Box is not enabled in this Chat, so it takes no Moves.`);
	const intent = facts.kind === "continuation" ? facts.intent : target.kind === "sibling" ? { type: "sibling" as const } : undefined;
	const pendingHumanText = target.kind === "send" && facts.kind === "send" && facts.reuseHumanMessageId === undefined ? humanMessageText(target.moves ?? {}, target.content, human.name, summary.boxes) : undefined;
	const scanMessages = rendered.map(({ message, content }) => ({ id: message.id, content }));
	const lore = hasEnabledLoreSlot(recipe.slots)
		? evaluateScopedLore({
			database: input.database,
			conversationId: input.conversationId,
			messages: scanMessages,
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
			macroWrites: message.variant === null ? [] : variantData.get(message.variant.id)?.macroWrites ?? [],
		})),
	}));
	const seed = input.seed ?? (target.kind === "sibling" && !target.reroll ? siblingSeed : undefined) ?? newVariantSeed();
	const preceding = participation.messages.at(-1);
	const boxIntent = target.kind === "continuation" || (target.kind === "sibling" && preceding !== undefined
		&& authorRoleOf(preceding, { humanParticipantId: human.id, modelParticipantId: model.id }) === "model") ? "continue" : "respond";
	// @approved
	//  Moves come from the triggering Human-authored Message: the one this Send
	//  submits, or the one a Sibling answers. A Continuation has none.
	const moves = boxIntent === "continue" ? {} : target.kind === "send" ? target.moves ?? {}
		: preceding === undefined ? {} : messageMoves.get(preceding.id) ?? {};
	const preparation = {
		seed,
		conversationId: input.conversationId,
		boxes: captureBoxes(boxes, summary.boxSetups, recordStates, moves, {
			database: input.database, conversationId: input.conversationId, seed, intent: boxIntent, human, cast: summary.cast, pending: pendingHumanText,
			messages: rendered.map(({ message, variantId, prose, speakerName, role, content }) => ({
				messageId: message.id, variantId, position: message.position, authorId: message.author?.participantId ?? null, speaker: speakerName, role, content, prose,
			})),
		}),
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
	return { ...preparation, target, facts, intent, pendingHumanText, scanMessages };
}

/** @approved
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
	const { boxes: boxInputs, ...preparation } = snapshot;
	// @approved
	//  The semantic pass reads the sources the synchronous pass captured: the
	// rendered selected history and pending human text, never a second render.
	const sources = preparation.lore.sources;
	const needsSemantic = hasEnabledLoreSlot(preparation.recipe.slots) &&
		preparation.lore.activation.mode === "keyword-fallback";
	const lorePromise = needsSemantic && sources !== undefined
		? evaluateScopedLoreAsync(sources, { fetch: input.preparationFetch, signal })
		: Promise.resolve(preparation.lore);
	const boxesPromise = advanceBoxes(boxInputs, boxServices(input.database, input.preparationFetch, signal));
	const [lore, boxes] = await Promise.all([lorePromise, boxesPromise]);
	signal.throwIfAborted();
	const ready: Preparation = {
		...preparation,
		lore,
		boxes,
		boxRecords: Object.fromEntries(boxInputs.flatMap(({ id, instance, reference }) => {
			const record = boxes[reference]?.record;
			return record === undefined ? [] : [[id, { instance, record }]];
		})),
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
		boxes: preparation.boxes,
		settings: preparation.settings,
		slots: preparation.recipe.slots,
		promptPresetId: preparation.recipe.id,
		attempt,
		connection: preparation.connection,
		lore: preparation.lore,
	};
};

// @approved
//  The retained provenance record: safe connection identity, model identity,
// and the attempt's Effective Generation Settings. Only fields in the shared
// provenance vocabulary are retained — an intent-inapplicable Continuation
// operand is already absent from the plan — and Request Overrides are never
// retained.
/** @approved
 * The shared Generation-start capture every lifecycle builds: the
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

/** @approved
 * Assemble the shared Generation-start capture: the complete compiled
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

/** @approved
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
