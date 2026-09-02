// ==[HUMAN APPROVED]== Server-owned Generation workflows.
//
// Composes the deep Conversation seam and the pure Prompt Compiler in one
// deterministic flow: read one authoritative snapshot, compile the
// provider-neutral Prompt Plan from the two controlled Participants and
// selected history, hand the plan to the injected model transport, and
// finally commit the transport's reply as a new Message authored by the
// Participant that occupied model Control when generation started. Everything
// the Message needs to be understood later — the immutable Author Stamp and
// the human/model historical pair — is captured at generation start, so
// concurrent renames or Definition edits never rewrite an in-flight
// Generation and affect only later ones.
//
// The transport is injected as a seam: this module stays independent of any
// concrete provider, streaming protocol, or credentials.
//
// Capture/derivation lives in generate-capture.ts; the detached scaffolding
// and provider-attempt tail live in generate-server-owned.ts. This module
// owns the public workflow entry points and their input/result contracts.

import type { Database } from "bun:sqlite";
import {
	createConversationModule,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
	type ConversationModule,
	type ConversationSnapshot,
	type AcceptedTailGeneration,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
} from "../conversation";
import type { PromptBudgetFailure, PromptPlan, GenerationIntent, TokenEstimator } from "../prompt-compiler";
import type { PromptHistoryEntry } from "../prompt-compiler";
import type {
	ModelClient,
	ModelClientConnectionSnapshot,
	ModelClientGenerationInput,
} from "../model-client";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import {
	runAcceptedGeneration,
	generationOutcomeData,
	startServerOwnedGenerationFrom,
	type GenerationAttemptInput,
	type GenerationOutcome,
	type ServerOwnedGeneration,
	type ServerOwnedGenerationCallbacks,
} from "./generate-server-owned";
import {
	captureSendGeneration,
	captureContinuationGeneration,
	captureSiblingGeneration,
	capturedAcceptanceFields,
	modelRequestFor,
	deriveGeneration,
	resolveConnectionApiFormat,
	toCompilerDefinition,
	type CapturedGeneration,
	type ParticipantPreview,
} from "./generate-capture";
import {
	compileGenerationPlan,
	continuationIntentFor,
	type EffectiveGenerationSettings,
} from "../generation-plan";

export type {
	GenerationAttemptInput,
	ServerOwnedGenerationControl,
	ServerOwnedGeneration,
	ServerOwnedGenerationCallbacks,
} from "./generate-server-owned";
export type { ParticipantPreview } from "./generate-capture";

async function notifyAccepted<Accepted>(
	input: { onAccepted?: (accepted: Accepted) => void | Promise<void> },
	accepted: Accepted,
): Promise<void> {
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// ==[HUMAN APPROVED]== Acceptance is authoritative even when an observing caller disconnects.
	}
}

interface GenerationLifecyclePolicy<
	Input extends GenerationAttemptInput,
	Capture extends CapturedGeneration,
	Accepted extends { generationId: number },
	Result,
> {
	preflight?: (input: Input) => void;
	expectedRevision?: (input: Input) => number;
	capture: (
		database: Database,
		snapshot: ConversationSnapshot,
		input: Input,
	) => Capture;
	accept: (
		conversation: ConversationModule,
		input: Input,
		capture: Capture,
		timestamp: string,
	) => Accepted;
	request: (
		capture: Capture,
		input: Input,
	) => ModelClientGenerationInput;
	resolve: (
		conversation: ConversationModule,
		input: Input,
		capture: Capture,
		accepted: Accepted,
		timestamp: string,
		outcome: GenerationOutcome,
	) => Result | Promise<Result>;
}

/**
 * ==[HUMAN APPROVED]== Run one server-owned Generation lifecycle from the shared seams.
 * Capture, acceptance, notification, provider execution, and terminal cleanup are
 * deliberately policy inputs: the runner owns their ordering while each lifecycle
 * keeps its own validation, request metadata, and resolution semantics.
 */
async function runGenerationLifecycle<
	Accepted extends { generationId: number },
	Input extends GenerationAttemptInput,
	Capture extends CapturedGeneration,
	Result,
>(
	database: Database,
	input: Input,
	onAccepted: ((accepted: Accepted) => void | Promise<void>) | undefined,
	policy: GenerationLifecyclePolicy<Input, Capture, Accepted, Result>,
): Promise<Result> {
	policy.preflight?.(input);
	const conversation = createConversationModule(database);
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
	const expectedRevision = policy.expectedRevision?.(input);
	if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
		throw new StaleConversationRevisionError(expectedRevision, snapshot.revision);
	}
	const capture = policy.capture(database, snapshot, input);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = policy.accept(conversation, input, capture, timestamp);
	await notifyAccepted<Accepted>({ onAccepted }, accepted);
	return runAcceptedGeneration(input, policy.request(capture, input), {
		remove: () => {
			conversation.removeGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		},
		resolve: (outcome) => policy.resolve(
			conversation,
			input,
			capture,
			accepted,
			timestamp,
			outcome,
		),
	});
}

// ==[HUMAN APPROVED]== Read-only prompt inspection result. `playable: false` means the
// Conversation cannot currently generate because the two distinct Control
// seats are not both occupied; the plan is then null.
export interface GenerationPromptInspection {
	conversationId: number;
	playable: boolean;
	humanParticipant: ParticipantPreview | null;
	modelParticipant: ParticipantPreview | null;
	plan: PromptPlan | null;
	// ==[HUMAN APPROVED]== The Effective Generation Settings a generation from the current captured
	// state would use: an ordinary Tail attempt, so the Continuation group is
	// absent and Request Overrides are narrowed to the active API Format.
	effectiveSettings: EffectiveGenerationSettings | null;
	// ==[HUMAN APPROVED]== The selected Continue request intent is exposed separately from the
	// ordinary Generate plan. Assistant prefill remains metadata here, never a
	// synthetic Conversation history block.
	continuationIntent: GenerationIntent | null;
	tokenEstimate: number | null;
	responseBudget: number | null;
	safetyAllowance: number | null;
	contextLimit: number | null;
	totalRequiredTokens: number | null;
	omittedHistory: readonly PromptHistoryEntry[];
	budgetFits: boolean | null;
	tokenEstimateIsApproximate: boolean;
	budgetFailure: PromptBudgetFailure | null;
}

export interface SendThroughProvisionalTailGenerationInput extends GenerationAttemptInput {
	// ==[HUMAN APPROVED]== Send is a revisioned acceptance operation. The submitted text is
	// included in Prompt preflight before the server writes either Message.
	expectedRevision: number;
	content: string;
	// ==[HUMAN APPROVED]== Fired immediately after the accepted human/provisional target
	// transaction commits and before provider contact begins.
	onAccepted?: (accepted: AcceptedTailGeneration) => void | Promise<void>;
}

export interface SendThroughProvisionalTailGenerationResult {
	conversation: ConversationSnapshot;
	generationId: number;
	humanMessageId: number;
	modelMessageId: number;
	provisionalVariantId: number;
}

export type ServerOwnedSendGeneration = ServerOwnedGeneration<
	AcceptedTailGeneration,
	SendThroughProvisionalTailGenerationResult
>;

export type ServerOwnedSendGenerationCallbacks = ServerOwnedGenerationCallbacks<AcceptedTailGeneration>;

// ==[HUMAN APPROVED]== Starts Send as a detached server-owned attempt. The caller receives an
// acceptance promise separately from the terminal result and may attach zero
// or more observers to the generation runtime in between. In particular, the
// caller's HTTP AbortSignal is intentionally not forwarded to the provider.
export function startServerOwnedSendGeneration(
	database: Database,
	input: SendThroughProvisionalTailGenerationInput,
	callbacks: ServerOwnedSendGenerationCallbacks = {},
): ServerOwnedSendGeneration {
	return startServerOwnedGenerationFrom(
		database,
		input,
		sendThroughProvisionalTailGeneration,
		callbacks,
	);
}

// ==[HUMAN APPROVED]== Compiles the Prompt Plan the server would send for a Tail Generation
// without contacting any transport. Exposes the agreed participant context
// (the Control pair and their plan) using provider-neutral vocabulary only.
export function inspectGenerationPrompt(
	database: Database,
	conversationId: number,
	options: {
		readonly tokenEstimator?: TokenEstimator;
		readonly connectionSettings?: ConnectionSettingsModuleOptions;
	} = {},
): GenerationPromptInspection {
	const snapshot = createConversationModule(database).getSnapshot(conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}

	const derivation = deriveGeneration(snapshot);
	if (derivation === null) {
		return {
			conversationId,
			playable: false,
			humanParticipant: null,
			modelParticipant: null,
			plan: null,
			effectiveSettings: null,
			continuationIntent: null,
			tokenEstimate: null,
			responseBudget: null,
			safetyAllowance: null,
			contextLimit: null,
			totalRequiredTokens: null,
			omittedHistory: [],
			budgetFits: null,
			tokenEstimateIsApproximate: false,
			budgetFailure: null,
		};
	}
	const settings = createConversationModule(database).getGenerationSettings(conversationId);
	if (settings === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	// ==[HUMAN APPROVED]== Inspection and execution compile through the one Generation Plan
	// Compiler, so the same captured inputs cannot produce drifting plans.
	// Like Send, the inspected attempt is an ordinary Tail Generation: the
	// compiled plan carries no Continuation intent, and the impossible-budget
	// failure is reported instead of thrown.
	const plan = compileGenerationPlan({
		human: toCompilerDefinition(derivation.human),
		model: toCompilerDefinition(derivation.model),
		history: derivation.history,
		historyRoles: derivation.historyRoles,
		settings,
		// ==[HUMAN APPROVED]== The safe Connection fact resolves before compilation so Request
		// Overrides are narrowed exactly as an executed attempt would narrow
		// them.
		connection: resolveConnectionApiFormat(database, options.connectionSettings),
		estimator: options.tokenEstimator,
	});
	const continuationIntent = continuationIntentFor(settings);

	return {
		conversationId,
		playable: true,
		humanParticipant: { id: derivation.human.id, name: derivation.human.name },
		modelParticipant: { id: derivation.model.id, name: derivation.model.name },
		plan: plan.promptPlan,
		effectiveSettings: plan.effectiveSettings,
		continuationIntent,
		tokenEstimate: plan.budget.tokenEstimate,
		responseBudget: plan.budget.responseBudget,
		safetyAllowance: plan.budget.safetyAllowance,
		contextLimit: plan.budget.contextLimit,
		totalRequiredTokens: plan.budget.totalRequiredTokens,
		omittedHistory: plan.budget.omittedHistory,
		budgetFits: plan.budget.fits,
		tokenEstimateIsApproximate: true,
		budgetFailure: plan.budget.failure,
	};
}

// ==[HUMAN APPROVED]== Send's accepted lifecycle is intentionally separate from the legacy
// Generate wrapper. Preflight is entirely read-only; only after it succeeds
// does the Conversation seam atomically create the human input, provisional
// model target, and Active Generation before this function contacts a Model
// Client.
export async function sendThroughProvisionalTailGeneration(
	database: Database,
	input: SendThroughProvisionalTailGenerationInput,
): Promise<SendThroughProvisionalTailGenerationResult> {
	return runGenerationLifecycle(database, input, input.onAccepted, {
		preflight: (current) => {
			if (current.content.trim() === "") {
				throw new InvalidConversationCommandError(
					"Send requires non-empty composer content.",
				);
			}
		},
		expectedRevision: (current) => current.expectedRevision,
		capture: (currentDatabase, snapshot, current) => captureSendGeneration(
			currentDatabase,
			snapshot,
			current.content,
			current.connection,
			current.connectionSettings,
			current.tokenEstimator,
		),
		accept: (conversation, current, capture, timestamp) => conversation.acceptTailGeneration({
			...capturedAcceptanceFields(capture, {
				conversationId: current.conversationId,
				timestamp,
			}),
			expectedRevision: current.expectedRevision,
			humanContent: capture.humanContent,
			reuseHumanMessageId: capture.reuseHumanMessageId,
		}),
		request: modelRequestFor,
		resolve: (conversation, current, _capture, accepted, timestamp, outcome) => ({
			conversation: conversation.resolveTailGeneration({
				conversationId: current.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				data: generationOutcomeData(outcome),
			}),
			generationId: accepted.generationId,
			humanMessageId: accepted.humanMessageId,
			modelMessageId: accepted.modelMessageId,
			provisionalVariantId: accepted.provisionalVariantId,
		}),
	});
}

export interface ContinueGenerationInput extends GenerationAttemptInput {
	// ==[HUMAN APPROVED]== Continue is a revisioned acceptance operation. The selected terminal
	// model Message and Variant are captured so a changed narrative position
	// cannot receive output from this attempt.
	expectedRevision: number;
	onAccepted?: (accepted: AcceptedContinuationGeneration) => void | Promise<void>;
}

export interface ContinueGenerationResult {
	conversation: ConversationSnapshot;
	generationId: number;
	modelMessageId: number;
	provisionalVariantId: number;
}

export type ServerOwnedContinuationGeneration = ServerOwnedGeneration<
	AcceptedContinuationGeneration,
	ContinueGenerationResult
>;

export type ServerOwnedContinuationGenerationCallbacks = ServerOwnedGenerationCallbacks<AcceptedContinuationGeneration>;

// ==[HUMAN APPROVED]== Continue starts from the selected narrative path and persists an ordinary
// model-authored Message. It shares the same normalized stream, terminal
// outcome, and provisional cleanup behavior as Send, but never inserts a
// Human-authored Message.
export async function continueGeneration(
	database: Database,
	input: ContinueGenerationInput,
): Promise<ContinueGenerationResult> {
	return runGenerationLifecycle(database, input, input.onAccepted, {
		expectedRevision: (current) => current.expectedRevision,
		capture: (currentDatabase, snapshot, current) => captureContinuationGeneration(
			currentDatabase,
			snapshot,
			current.connection,
			current.connectionSettings,
			current.tokenEstimator,
		),
		accept: (conversation, current, capture, timestamp) => conversation.acceptContinuationGeneration({
			...capturedAcceptanceFields(capture, {
				conversationId: current.conversationId,
				timestamp,
			}),
			expectedRevision: current.expectedRevision,
			precedingMessageId: capture.precedingMessageId,
			precedingVariantId: capture.precedingVariantId,
			generationIntent: capture.intent,
		}),
		request: (capture, current) => ({
			...modelRequestFor(capture, current),
			assistantPrefill: capture.assistantPrefill,
		}),
		resolve: (conversation, current, capture, accepted, timestamp, outcome) => ({
			conversation: conversation.resolveTailGeneration({
				conversationId: current.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				data: [
					{ namespace: "generation", key: "intent", value: JSON.stringify(capture.intent) },
					...generationOutcomeData(outcome),
				],
			}),
			generationId: accepted.generationId,
			modelMessageId: accepted.modelMessageId,
			provisionalVariantId: accepted.provisionalVariantId,
		}),
	});
}

export function startServerOwnedContinuationGeneration(
	database: Database,
	input: ContinueGenerationInput,
	callbacks: ServerOwnedContinuationGenerationCallbacks = {},
): ServerOwnedContinuationGeneration {
	return startServerOwnedGenerationFrom(
		database,
		input,
		continueGeneration,
		callbacks,
	);
}

export interface GenerateSiblingVariantInput {
	conversationId: number;
	// ==[HUMAN APPROVED]== The target Message whose captured historical Control pair governs this
	// sibling generation. Current Control is deliberately ignored: Swiping an
	// older Message reproduces the participants who were playing when it was
	// generated, and never reassigns the seats.
	messageId: number;
	// ==[HUMAN APPROVED]== The provider-neutral Model Client receives the compiled Prompt Plan and
	// returns normalized asynchronous events for the sibling Variant.
	modelClient: ModelClient;
	connection?: ModelClientConnectionSnapshot | null;
	connectionSettings?: ConnectionSettingsModuleOptions;
	signal?: AbortSignal;
	onEvent?: (event: import("../model-client").ModelClientEvent) => void | Promise<void>;
	onBeforeTerminal?: () => void | Promise<void>;
	onAccepted?: (accepted: AcceptedSiblingGeneration) => void | Promise<void>;
	tokenEstimator?: TokenEstimator;
	// ==[HUMAN APPROVED]== Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
}

export interface SiblingGenerationResult {
	conversation: ConversationSnapshot;
	generationId: number;
	messageId: number;
	provisionalVariantId: number;
}

export type ServerOwnedSiblingGeneration = ServerOwnedGeneration<
	AcceptedSiblingGeneration,
	SiblingGenerationResult
>;

export type ServerOwnedSiblingGenerationCallbacks = ServerOwnedGenerationCallbacks<AcceptedSiblingGeneration>;

// ==[HUMAN APPROVED]== Targeted Swipe: generates a new sibling Variant for an existing native
// Message using the historical Control pair captured when that Message was
// generated or its openings were configured. The historical pair's current
// Definitions and names compile the plan; current generation settings and
// the selected history preceding the target Message complete it. The commit
// appends the sibling without changing current Control or the Author Stamp.
export async function generateSiblingVariant(
	database: Database,
	input: GenerateSiblingVariantInput,
): Promise<ConversationSnapshot> {
	// ==[HUMAN APPROVED]== Sibling capture remains revision-neutral: the target's historical pair
	// and the sibling acceptance seam own its distinct eligibility and parallel-at-position rules.
	return runGenerationLifecycle(database, input, input.onAccepted, {
		capture: (currentDatabase, snapshot, current) => captureSiblingGeneration(
			currentDatabase,
			snapshot,
			current,
		),
		accept: (conversation, current, capture, timestamp) => conversation.acceptSiblingGeneration({
			...capturedAcceptanceFields(capture, {
				conversationId: current.conversationId,
				timestamp,
			}),
			messageId: current.messageId,
			generationIntent: { type: "sibling" },
		}),
		request: modelRequestFor,
		resolve: (conversation, current, _capture, accepted, timestamp, outcome) =>
			conversation.resolveSiblingGeneration({
				conversationId: current.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				data: generationOutcomeData(outcome),
			}),
	});
}

// ==[HUMAN APPROVED]== Detached server-owned Sibling Generation. The acceptance promise resolves
// before provider contact so several attempts can be started and observed
// independently without coupling work to one HTTP subscriber.
export function startServerOwnedSiblingGeneration(
	database: Database,
	input: GenerateSiblingVariantInput,
	callbacks: ServerOwnedSiblingGenerationCallbacks = {},
): ServerOwnedSiblingGeneration {
	const started = startServerOwnedGenerationFrom(
		database,
		input,
		generateSiblingVariant,
		callbacks,
	);
	return {
		accepted: started.accepted,
		result: started.result.then(async (conversation) => {
			const accepted = await started.accepted;
			return {
				conversation,
				generationId: accepted.generationId,
				messageId: accepted.messageId,
				provisionalVariantId: accepted.provisionalVariantId,
			};
		}),
		signal: started.signal,
	};
}
