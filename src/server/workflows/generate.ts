// Server-owned Generation workflows.
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
	type ConversationSnapshot,
	type AcceptedTailGeneration,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
} from "../conversation";
import type { PromptBudgetFailure, PromptPlan, GenerationIntent, TokenEstimator } from "../prompt-compiler";
import type { PromptHistoryEntry } from "../prompt-compiler";
import type { ModelClient, ModelClientConnectionSnapshot } from "../model-client";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import {
	runAcceptedGeneration,
	generationOutcomeData,
	startServerOwnedGenerationFrom,
	type GenerationAttemptInput,
	type ServerOwnedGeneration,
	type ServerOwnedGenerationCallbacks,
} from "./generate-server-owned";
import {
	captureSendGeneration,
	captureContinuationGeneration,
	captureSiblingGeneration,
	deriveGeneration,
	createBudgetedPlan,
	promptPlanJson,
	generationSettingsJson,
	connectionJson,
	promptInspectionJson,
	toModelClientGenerationSettings,
	type ParticipantPreview,
} from "./generate-capture";

export type {
	GenerationAttemptInput,
	ServerOwnedGenerationControl,
	ServerOwnedGeneration,
	ServerOwnedGenerationCallbacks,
} from "./generate-server-owned";
export type { ParticipantPreview } from "./generate-capture";

// Read-only prompt inspection result. `playable: false` means the
// Conversation cannot currently generate because the two distinct Control
// seats are not both occupied; the plan is then null.
export interface GenerationPromptInspection {
	conversationId: number;
	playable: boolean;
	humanParticipant: ParticipantPreview | null;
	modelParticipant: ParticipantPreview | null;
	plan: PromptPlan | null;
	// The selected Continue request intent is exposed separately from the
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
	// Send is a revisioned acceptance operation. The submitted text is
	// included in Prompt preflight before the server writes either Message.
	expectedRevision: number;
	content: string;
	// Fired immediately after the accepted human/provisional target
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

// Starts Send as a detached server-owned attempt. The caller receives an
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

// Compiles the Prompt Plan the server would send for a Tail Generation
// without contacting any transport. Exposes the agreed participant context
// (the Control pair and their plan) using provider-neutral vocabulary only.
export function inspectGenerationPrompt(
	database: Database,
	conversationId: number,
	options: { readonly tokenEstimator?: TokenEstimator } = {},
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
	const budget = createBudgetedPlan(derivation, settings, options.tokenEstimator);
	const continuationIntent: GenerationIntent = settings.continuationStrategy === "instruction"
		? {
			type: "continuation",
			strategy: "instruction",
			instruction: settings.continuationInstruction,
		}
		: {
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: settings.continuationPrefillSuffix,
		};

	return {
		conversationId,
		playable: true,
		humanParticipant: derivation.humanParticipant,
		modelParticipant: derivation.modelParticipant,
		plan: budget.plan,
		continuationIntent,
		tokenEstimate: budget.tokenEstimate,
		responseBudget: budget.responseBudget,
		safetyAllowance: budget.safetyAllowance,
		contextLimit: budget.contextLimit,
		totalRequiredTokens: budget.totalRequiredTokens,
		omittedHistory: budget.omittedHistory,
		budgetFits: budget.fits,
		tokenEstimateIsApproximate: true,
		budgetFailure: budget.failure,
	};
}

/**
 * Test-fixture seam for suites that need a terminal model Message without a
 * user Send. It composes the production Continuation lifecycle — acceptance
 * followed by resolution — instead of a parallel commit path, so fixtures
 * exercise the same Active Generation persistence, Author Stamp capture, and
 * terminal rules every server-owned Generation uses. It is therefore absent
 * from the public workflow barrel and every HTTP route. Product code must
 * use the server-owned Send, Continue, or Sibling starts.
 */
export async function generateTerminalTailFixture(
	database: Database,
	input: GenerationAttemptInput,
): Promise<ConversationSnapshot> {
	const snapshot = createConversationModule(database).getSnapshot(input.conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(input.conversationId);
	}
	const result = await continueGeneration(database, {
		...input,
		expectedRevision: snapshot.revision,
	});
	return result.conversation;
}

// Send's accepted lifecycle is intentionally separate from the legacy
// Generate wrapper. Preflight is entirely read-only; only after it succeeds
// does the Conversation seam atomically create the human input, provisional
// model target, and Active Generation before this function contacts a Model
// Client.
export async function sendThroughProvisionalTailGeneration(
	database: Database,
	input: SendThroughProvisionalTailGenerationInput,
): Promise<SendThroughProvisionalTailGenerationResult> {
	if (input.content.trim() === "") {
		throw new InvalidConversationCommandError(
			"Send requires non-empty composer content.",
		);
	}
	const conversation = createConversationModule(database);
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
	if (snapshot.revision !== input.expectedRevision) {
		throw new StaleConversationRevisionError(
			input.expectedRevision,
			snapshot.revision,
		);
	}
	const capture = captureSendGeneration(
		database,
		snapshot,
		input.content,
		input.connection,
		input.connectionSettings,
		input.tokenEstimator,
	);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = conversation.acceptTailGeneration({
		conversationId: input.conversationId,
		expectedRevision: input.expectedRevision,
		timestamp,
		humanContent: capture.humanContent,
		reuseHumanMessageId: capture.reuseHumanMessageId,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		capturedHumanName: capture.humanParticipant.name,
		capturedModelName: capture.author.capturedName,
		promptPlan: promptPlanJson(capture.promptPlan),
		promptInspection: promptInspectionJson(capture.budget),
		historyRoles: capture.historyRoles,
		generationSettings: generationSettingsJson({
			modelId: capture.settings.modelId,
			siblingGenerationLimit: capture.settings.siblingGenerationLimit,
			continuationStrategy: capture.settings.continuationStrategy,
			continuationInstruction: capture.settings.continuationInstruction,
			continuationPrefillSuffix: capture.settings.continuationPrefillSuffix,
			...toModelClientGenerationSettings(capture.settings),
		}),
		connection: connectionJson(capture.connection),
		provenance: capture.provenance,
	});
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// Acceptance is authoritative even when an observing transport has
		// disconnected. Continue the server-owned provider attempt.
	}

	const committed = await runAcceptedGeneration(input, {
		promptPlan: capture.promptPlan,
		historyRoles: capture.historyRoles,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		connection: capture.connection,
		signal: input.signal,
	}, {
		remove: () => {
			conversation.removeTailGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		},
		resolve: (outcome) => conversation.resolveTailGeneration({
			conversationId: input.conversationId,
			generationId: accepted.generationId,
			timestamp,
			content: outcome.content,
			data: generationOutcomeData(outcome),
		}),
	});
	return {
		conversation: committed,
		generationId: accepted.generationId,
		humanMessageId: accepted.humanMessageId,
		modelMessageId: accepted.modelMessageId,
		provisionalVariantId: accepted.provisionalVariantId,
	};
}

export interface ContinueGenerationInput extends GenerationAttemptInput {
	// Continue is a revisioned acceptance operation. The selected terminal
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

// Continue starts from the selected narrative path and persists an ordinary
// model-authored Message. It shares the same normalized stream, terminal
// outcome, and provisional cleanup behavior as Send, but never inserts a
// Human-authored Message.
export async function continueGeneration(
	database: Database,
	input: ContinueGenerationInput,
): Promise<ContinueGenerationResult> {
	const conversation = createConversationModule(database);
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
	if (snapshot.revision !== input.expectedRevision) {
		throw new StaleConversationRevisionError(input.expectedRevision, snapshot.revision);
	}
	const capture = captureContinuationGeneration(
		database,
		snapshot,
		input.connection,
		input.connectionSettings,
		input.tokenEstimator,
	);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = conversation.acceptContinuationGeneration({
		conversationId: input.conversationId,
		expectedRevision: input.expectedRevision,
		timestamp,
		precedingMessageId: capture.precedingMessageId,
		precedingVariantId: capture.precedingVariantId,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		capturedHumanName: capture.humanParticipant.name,
		capturedModelName: capture.author.capturedName,
		promptPlan: promptPlanJson(capture.promptPlan),
		promptInspection: promptInspectionJson(capture.budget),
		historyRoles: capture.historyRoles,
		generationSettings: generationSettingsJson({
			modelId: capture.settings.modelId,
			siblingGenerationLimit: capture.settings.siblingGenerationLimit,
			continuationStrategy: capture.settings.continuationStrategy,
			continuationInstruction: capture.settings.continuationInstruction,
			continuationPrefillSuffix: capture.settings.continuationPrefillSuffix,
			...toModelClientGenerationSettings(capture.settings),
		}),
		connection: connectionJson(capture.connection),
		generationIntent: capture.intent,
		provenance: capture.provenance,
	});
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// Acceptance is authoritative even when the observing caller disconnects.
	}
	const committed = await runAcceptedGeneration(input, {
		promptPlan: capture.promptPlan,
		historyRoles: capture.historyRoles,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		assistantPrefill: capture.assistantPrefill,
		connection: capture.connection,
		signal: input.signal,
	}, {
		remove: () => {
			conversation.removeTailGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		},
		resolve: (outcome) => conversation.resolveTailGeneration({
			conversationId: input.conversationId,
			generationId: accepted.generationId,
			timestamp,
			content: outcome.content,
			data: [
				{ namespace: "generation", key: "intent", value: JSON.stringify(capture.intent) },
				...generationOutcomeData(outcome),
			],
		}),
	});
	return {
		conversation: committed,
		generationId: accepted.generationId,
		modelMessageId: accepted.modelMessageId,
		provisionalVariantId: accepted.provisionalVariantId,
	};
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
	// The target Message whose captured historical Control pair governs this
	// sibling generation. Current Control is deliberately ignored: Swiping an
	// older Message reproduces the participants who were playing when it was
	// generated, and never reassigns the seats.
	messageId: number;
	// The provider-neutral Model Client receives the compiled Prompt Plan and
	// returns normalized asynchronous events for the sibling Variant.
	modelClient: ModelClient;
	connection?: ModelClientConnectionSnapshot | null;
	connectionSettings?: ConnectionSettingsModuleOptions;
	signal?: AbortSignal;
	onEvent?: (event: import("../model-client").ModelClientEvent) => void | Promise<void>;
	onBeforeTerminal?: () => void | Promise<void>;
	onAccepted?: (accepted: AcceptedSiblingGeneration) => void | Promise<void>;
	tokenEstimator?: TokenEstimator;
	// Optional explicit write time; defaults to the current wall clock.
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

// Targeted Swipe: generates a new sibling Variant for an existing native
// Message using the historical Control pair captured when that Message was
// generated or its openings were configured. The historical pair's current
// Definitions and names compile the plan; current generation settings and
// the selected history preceding the target Message complete it. The commit
// appends the sibling without changing current Control or the Author Stamp.
export async function generateSiblingVariant(
	database: Database,
	input: GenerateSiblingVariantInput,
): Promise<ConversationSnapshot> {
	const conversation = createConversationModule(database);

	// Generation-start capture: one authoritative snapshot derives the plan
	// from the target Message's historical pair; concurrent edits land and
	// affect only later sibling generations.
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(input.conversationId);
	}
	const capture = captureSiblingGeneration(database, snapshot, input);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = conversation.acceptSiblingGeneration({
		conversationId: input.conversationId,
		messageId: input.messageId,
		timestamp,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		capturedHumanName: capture.humanParticipant.name,
		capturedModelName: capture.author.capturedName,
		promptPlan: promptPlanJson(capture.promptPlan),
		promptInspection: promptInspectionJson(capture.budget),
		historyRoles: capture.historyRoles,
		generationSettings: generationSettingsJson({
			modelId: capture.settings.modelId,
			siblingGenerationLimit: capture.settings.siblingGenerationLimit,
			continuationStrategy: capture.settings.continuationStrategy,
			continuationInstruction: capture.settings.continuationInstruction,
			...toModelClientGenerationSettings(capture.settings),
		}),
		connection: connectionJson(capture.connection),
		generationIntent: { type: "sibling" },
		provenance: capture.provenance,
	});
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// Acceptance is authoritative even if an observer disconnects while
		// the provider request is being started.
	}
	return runAcceptedGeneration(input, {
		promptPlan: capture.promptPlan,
		historyRoles: capture.historyRoles,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		connection: capture.connection,
		signal: input.signal,
	}, {
		remove: () => {
			conversation.removeSiblingGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		},
		resolve: (outcome) => conversation.resolveSiblingGeneration({
			conversationId: input.conversationId,
			generationId: accepted.generationId,
			timestamp,
			content: outcome.content,
			data: generationOutcomeData(outcome),
		}),
	});
}

// Detached server-owned Sibling Generation. The acceptance promise resolves
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
