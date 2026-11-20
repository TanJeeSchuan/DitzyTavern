import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";
import {
	authorRoleOf,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	generationGate,
	InvalidConversationCommandError,
	promptIntentOf,
	readConversationGenerationSettingsFromConnection,
	readConversationSummaryFromConnection,
	readSelectedHistoryFromConnection,
	readVariantData,
	requireSiblingHistoricalControl,
	requireTerminalTarget,
	runConversationReadTransaction,
	type CapturedGenerationTarget,
	type CastParticipantSnapshot,
	type ConversationDatabase,
	type ConversationGenerationSettings,
	type HistoricalControlSnapshot,
	type SelectedHistoryRead,
} from "../conversation";
import { readConversationPromptPresetRecipeFromConnection, type PromptPresetRecipe } from "../prompt-preset";
import { evaluateScopedLore, evaluateScopedLoreAsync, noLoreEvaluation, type ScopedLoreEvaluation } from "../lorebook/evaluation";
import { promptImageResolutionFor } from "./prompt-image-resolution";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import { generationRuntimeFor } from "./generation-runtime";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { compileGenerationPlan, continuationIntentFor, type GenerationPlan } from "../generation-plan";
import type { PromptContextEntry, PromptWarning, TokenEstimator } from "../prompt-compiler";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ModelClientConnectionSnapshot, ModelFetch } from "../model-client";
import { hasEnabledLoreSlot } from "../../shared/contract/prompt-preset";
import { createAttemptEnvironment } from "../../shared/prompt-macro-engine";
import type { GenerationFormattingContext, GenerationTarget } from "../../shared/contract/conversation-schema";
import type { MacroVariableWrite } from "../../shared/contract/macro-variables";
import { deriveMacroState, macroInitialValuePrefix } from "../prompt-macros";
import type { MacroValue } from "../../shared/contract/macro-variable-write";
import { MACRO_DATA_NAMESPACE } from "../../shared/variant-data-codecs";
import { boxServices } from "../box/services";
import type { CaptureRead } from "../box/contract";
import { withBoxOperations, advanceBoxes, captureBoxes, chatBoxes, participatingBoxes, type BoxResults, type BoxInputs } from "../box/registry";
import { readBoxFolds, readVariantSeeds } from "../box/records";
import { newVariantSeed, variantSeedOf } from "../box/seed";
import { humanMessageText, readMessageMoves } from "../box/moves";
import { boxMovesError, sameMoves, type BoxMoves, type BoxRecords } from "../../shared/contract/box-generation";
import { readBoxLifecycles } from "../box/setup";
import type { BoxImageGrants } from "../prompt-compiler/images";
import { captureBoxPromptImages } from "../box/prompt-images";

interface GenerationDerivation {
	human: CastParticipantSnapshot;
	model: CastParticipantSnapshot;
	context: readonly PromptContextEntry[];
}

interface PreparationFields {
	readonly conversationId: number;
	readonly semanticTriggerRevision: number;
	readonly formatting: GenerationFormattingContext;
	readonly derivation: GenerationDerivation;
	readonly settings: ConversationGenerationSettings;
	readonly recipe: PromptPresetRecipe;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly macroState: ReadonlyMap<string, MacroValue>;
	readonly lore: ScopedLoreEvaluation;
	readonly boxWarnings: readonly PromptWarning[];
	readonly boxImages: BoxImageGrants;
	readonly seed: string;
	readonly target: CapturedGenerationTarget;
	readonly pendingHumanText: string | undefined;
}

export interface PreparationSnapshot extends PreparationFields {
	readonly boxes: BoxInputs;
}

interface Preparation extends PreparationFields {
	readonly boxes: BoxResults;
	readonly boxRecords: BoxRecords;
	readonly fingerprint: string;
}

const reusableHumanMessageId = (
	messages: readonly SelectedHistoryRead["messages"][number][],
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

interface CapturedTargetFacts {
	readonly captured: CapturedGenerationTarget;
	readonly moves: BoxMoves;
	readonly boxIntent: CaptureRead["intent"];
	readonly seedDefault?: string | undefined;
	readonly pendingHuman?: string | undefined;
}

/** @approved Gate the captured target before checking playability. Resolve terminal eligibility after rendering history. */
interface TargetCapture {
	readonly historyBound?: number;
	readonly gate?: () => void;
	resolve(inputs: {
		history: SelectedHistoryRead;
		control: HistoricalControlSnapshot;
		messageMoves: ReadonlyMap<number, BoxMoves>;
		chat: ReturnType<typeof chatBoxes>;
	}): CapturedTargetFacts;
}

function captureTarget(
	db: ConversationDatabase,
	conversationId: number,
	target: GenerationTarget,
	settings: ConversationGenerationSettings,
): TargetCapture {
	switch (target.kind) {
		case "send": return {
			resolve({ history, control, messageMoves, chat }) {
				const reuseHumanMessageId = reusableHumanMessageId(history.messages, control.humanParticipantId, target, messageMoves);
				const moves = target.moves ?? {};
				const invalid = boxMovesError(moves, (id) => chat.get(id)?.descriptor);
				if (invalid !== undefined) throw new InvalidConversationCommandError(invalid);
				return {
					captured: { ...target, reuseHumanMessageId },
					boxIntent: "respond",
					moves,
					pendingHuman: reuseHumanMessageId === undefined ? target.content : undefined,
				};
			},
		};
		case "sibling": return {
			historyBound: target.messageId,
			gate: () => requireSiblingHistoricalControl(db, conversationId, target.messageId),
			resolve({ history, control, messageMoves }) {
				const preceding = history.messages.at(-1);
				const responds = preceding === undefined || authorRoleOf(preceding, control) !== "model";
				const variantId = history.target?.variant?.id;
				const seedDefault = target.reroll || variantId === undefined
					? undefined
					: variantSeedOf(readVariantSeeds(db, [variantId]).get(variantId), variantId);
				return {
					captured: target,
					boxIntent: responds ? "respond" : "continue",
					moves: responds && preceding !== undefined ? messageMoves.get(preceding.id) ?? {} : {},
					seedDefault,
				};
			},
		};
		case "continuation": return {
			gate: () => generationGate(db, conversationId, { type: "accept-continuation" }),
			resolve() {
				const terminal = requireTerminalTarget(db, conversationId, settings.continuationStrategy);
				return {
					captured: { ...target, precedingMessageId: terminal.messageId, precedingVariantId: terminal.variantId, intent: continuationIntentFor(settings) },
					boxIntent: "continue",
					moves: {},
				};
			},
		};
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

// @approved
// A Generation's capture and a preview's acceptance call hooks only of Boxes
// enabled in the Chat. A Box left out still runs correctly, each hook in a
// fresh context of its own, so a selection that changes while runtimes are
// created fails nothing.
export const withGenerationBoxOperations = <T>({ database, conversationId }: Pick<PrepareGenerationInputs, "database" | "conversationId">, run: () => T): Promise<Awaited<T>> => {
	const db = drizzle(database);
	const lifecycles = readBoxLifecycles(db, conversationId);
	return withBoxOperations([...chatBoxes(db, conversationId)].flatMap(([id, loaded]) => lifecycles[id]?.state === "enabled" ? [loaded] : []), run);
};

/** @approved
 * Read the deterministic inputs for one attempt through the focused Conversation seams, in one
 * read transaction that also covers each Box's capture. The returned snapshot is safe to retain
 * while the canonical async preparation completes semantic evaluation: compilation and preview
 * validation never reread mutable history or execute macros.
 */
export const prepareGenerationInputsSnapshot = (input: PrepareGenerationInputs): PreparationSnapshot =>
	runConversationReadTransaction(input.database, (db) => snapshotGenerationInputs(db, input));

function snapshotGenerationInputs(db: ConversationDatabase, input: PrepareGenerationInputs): PreparationSnapshot {
	const { target, connection } = input;
	const summary = readConversationSummaryFromConnection(db, input.conversationId);
	if (summary === undefined) throw new ConversationNotFoundError(input.conversationId);
	const recipe = readConversationPromptPresetRecipeFromConnection(db, input.conversationId);
	const settings = readConversationGenerationSettingsFromConnection(db, input.conversationId);
	if (recipe === undefined || settings === undefined) {
		throw new InvalidConversationCommandError("The Conversation's generation inputs are unavailable.");
	}
	const targetCapture = captureTarget(db, input.conversationId, target, settings);
	const selected = readSelectedHistoryFromConnection(db, input.conversationId, {
		targetMessageId: targetCapture.historyBound,
		conversationDataNamespace: MACRO_DATA_NAMESPACE,
		conversationDataKeyPrefix: macroInitialValuePrefix(recipe.id),
	});
	if (selected === undefined) throw new ConversationNotFoundError(input.conversationId);
	const variantIds = selected.messages.flatMap((message) => message.variant === null ? [] : [message.variant.id]);
	const boxWarnings: PromptWarning[] = [];
	const chat = chatBoxes(db, input.conversationId);
	const boxImages = captureBoxPromptImages(db, chat);
	const boxes = participatingBoxes(chat, recipe.slots, readBoxLifecycles(db, input.conversationId));
	const variantData = readVariantData(db, variantIds, ["macroWrites"]);
	const folds = readBoxFolds(db, variantIds, summary.boxSetups, boxes);
	const messageMoves = readMessageMoves(db, input.conversationId, selected.messages.map(({ id }) => id));
	targetCapture.gate?.();
	const historicalControl = selected.target?.historicalContext;
	const human = summary.cast.find((participant) =>
		participant.id === (historicalControl?.humanParticipantId ?? summary.control.humanParticipantId));
	const model = summary.cast.find((participant) =>
		participant.id === (historicalControl?.modelParticipantId ?? summary.control.modelParticipantId));
	if (human === undefined || model === undefined || human.id === model.id) {
		throw new ConversationNotPlayableError(input.conversationId);
	}
	// @approved
	//  The selected Messages as the model reads them, each Message's Moves
	// rendered before its prose: prompt history, Lore scanning and each
	// Box's capture all read this one projection.
	const control = { humanParticipantId: human.id, modelParticipantId: model.id };
	const rendered = selected.messages.flatMap((message) => message.variant === null ? [] : [{
		message,
		variantId: message.variant.id,
		prose: message.variant.content,
		speakerName: message.author?.capturedName ?? null,
		role: authorRoleOf(message, control),
		content: humanMessageText(messageMoves.get(message.id) ?? {}, message.variant.content, message.author?.capturedName ?? null, chat, summary.boxes, boxImages, boxWarnings),
	}]);
	const derivation: GenerationDerivation = {
		human,
		model,
		context: rendered.map(({ speakerName, content, role }) => ({ kind: "message", speakerName, content, role })),
	};
	const { captured, pendingHuman, moves, boxIntent, seedDefault } = targetCapture.resolve({ history: selected, control, messageMoves, chat });
	// @approved
	// Only an enabled Box accepts newly staged Moves. A resent Message keeps its Moves.
	const closed = pendingHuman === undefined ? undefined : Object.keys(moves).find((id) => summary.boxes[id] !== "enabled");
	if (closed !== undefined) throw new InvalidConversationCommandError(`The ${closed} Box is not enabled in this Chat, so it takes no Moves.`);
	const pendingHumanText = pendingHuman === undefined
		? undefined
		: humanMessageText(moves, pendingHuman, human.name, chat, summary.boxes, boxImages, boxWarnings);
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
	const macroState = new Map(deriveMacroState({
		initialData: selected.initialData,
		presetId: recipe.id,
		selectedVariants: selected.messages.map((message) => ({
			selected: message.variant !== null,
			macroWrites: message.variant === null ? [] : variantData.get(message.variant.id)?.macroWrites ?? [],
		})),
	}));
	const seed = input.seed ?? seedDefault ?? newVariantSeed();
	return {
		target: captured,
		pendingHumanText,
		seed,
		boxWarnings, boxImages,
		conversationId: input.conversationId,
		boxes: captureBoxes(boxes, summary.boxSetups, folds, moves, {
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
		settings,
		recipe,
		connection,
		macroState,
		lore,
	};
}

/** @approved
 * Capture the same immutable inputs as prepareGenerationInputsSnapshot, completing the one
 * asynchronous semantic pass before a Generation Plan is compiled. Every caller
 * receives a Promise, including the no-semantic-work path, so Send, Continuation,
 * Sibling, and inspected Prompt Plan preparation share one asynchronous seam.
 */
const prepareGenerationInputsAsync = (input: PrepareGenerationInputs): Promise<Preparation> =>
	withGenerationBoxOperations(input, async () => {
	const signal = generationRuntimeFor(input.database).shutdownSignal;
	signal.throwIfAborted();
	// @approved
	//  The snapshot is captured before semantic work can suspend, so books,
	// attachments, history, settings, and participant data remain the exact values observed at
	// generation start.
	const snapshot = prepareGenerationInputsSnapshot(input);
	const fingerprint = generationPreparationFingerprint(snapshot);
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
		boxRecords: Object.fromEntries(boxInputs.flatMap(({ id, instance, version, reference }) => {
			const record = boxes[reference]?.record;
			return record === undefined ? [] : [[id, { instance, ...version !== undefined && { version }, record }]];
		})),
		fingerprint,
	};
	return ready;
});

export interface CapturedGeneration {
	readonly preparation: Preparation;
	readonly plan: GenerationPlan;
	readonly macroWrites: readonly MacroVariableWrite[];
}

export async function captureGeneration(
	database: Database,
	target: GenerationTarget,
	options: GenerationCaptureOptions,
): Promise<CapturedGeneration> {
	const preparation = await prepareGenerationInputsAsync({ database, target, ...options });
	const { human, model, context } = preparation.derivation;
	const attempt = createAttemptEnvironment({
		self: human.name,
		other: model.name,
		conversationId: preparation.conversationId,
		promptPresetId: preparation.recipe.id,
		now: new Date(),
		random: Math.random,
		timeZone: preparation.formatting.timeZone,
		locale: preparation.formatting.locale,
		variables: preparation.macroState,
	});
	const compiled = compileGenerationPlan({
		human,
		model,
		context: preparation.pendingHumanText === undefined ? context : [
			...context, { kind: "message", speakerName: human.name, content: preparation.pendingHumanText, role: "human" },
		],
		boxes: preparation.boxes,
		recipe: preparation.recipe.slots,
		lore: preparation.lore.candidates,
		loreAllowance: preparation.lore.allowance,
		loreActivation: preparation.lore.activation,
		attempt,
		intent: promptIntentOf(preparation.target),
		settings: preparation.settings,
		connection: preparation.connection,
		estimator: options.tokenEstimator,
		images: { ...promptImageResolutionFor(database, preparation.connection, preparation.settings), boxGrants: preparation.boxImages },
	});
	compiled.promptPlan.warnings.push(...preparation.boxWarnings);
	const automaticLoreText = compiled.promptPlan.blocks.find((block) => block.kind === "lore")?.content ?? "";
	const plan = {
		...compiled,
		loreActivation: compiled.loreActivation === null ? null : {
			...compiled.loreActivation,
			automaticLoreText,
			finalLoreText: automaticLoreText,
		},
	};
	return { preparation, plan, macroWrites: [...attempt.state.writes] };
}
