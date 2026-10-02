// ==[HUMAN APPROVED]== Server-owned Generation workflows.
//
// Composes the deep Conversation seam and the pure Prompt Compiler in one
// deterministic flow: prepare one immutable set of generation inputs, compile
// the provider-neutral Prompt Plan from the two controlled Participants and
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
	StaleConversationRevisionError,
	type ConversationModule,
	type ConversationDataEntry,
	type ConversationSummary,
	type AcceptedTailGeneration,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
} from "../conversation";
import type { TokenEstimator } from "../prompt-compiler";
import type {
	ModelClient,
	ModelClientConnectionSnapshot,
	ModelClientGenerationInput,
	ModelClientEvent,
} from "../model-client";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { GenerationFormattingContext } from "../../shared/contract/conversation-schema";
import { generationRuntimeFor } from "./generation-runtime";
import {
	runAcceptedGeneration,
	generationOutcomeData,
	startServerOwnedGenerationFrom,
	type GenerationAttemptInput,
	type ServerOwnedGeneration,
	type ServerOwnedGenerationCallbacks,
} from "./generate-server-owned";
import {
	captureSendGenerationAsync,
	captureContinuationGenerationAsync,
	captureSiblingGenerationAsync,
	capturedAcceptanceFields,
	modelRequestFor,
	type CapturedGeneration,
} from "./generate-capture";
import {
	consumeGenerationPreview,
	captureContinuationGenerationPreview,
	captureSendGenerationPreview,
	captureSiblingGenerationPreview,
	type GenerationPreviewAcceptance,
	type GenerationPreviewAcceptanceFor,
} from "./generation-preview";
import {
	assertGenerationPlan,
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

// ==[HUMAN APPROVED]== What acceptance must report for the runner to finish a Generation
// without asking the lifecycle anything further.
interface AcceptedGenerationTarget {
	generationId: number;
	conversation: ConversationSummary;
}

interface GenerationLifecyclePolicy<
	Input extends GenerationAttemptInput,
	Capture extends CapturedGeneration,
	Accepted extends AcceptedGenerationTarget,
> {
	capture: (
		database: Database,
		conversationId: number,
		input: Input,
	) => Promise<Capture>;
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
	// ==[HUMAN APPROVED]== Terminal Conversation data particular to this lifecycle, recorded
	// ahead of the shared outcome entries. Only Continue has any.
	terminalData?: (capture: Capture) => readonly ConversationDataEntry[];
}

type PreviewableGenerationAttemptInput = GenerationAttemptInput & {
	readonly preview?: GenerationPreviewAcceptance;
};

/**
 * ==[HUMAN APPROVED]== Run one server-owned Generation lifecycle from the shared seams.
 * What differs between Send, Continue, and Sibling is what they capture, how
 * they accept, and what they ask the provider for. Resolution does not
 * differ: the runner commits the terminal outcome and reports the acceptance
 * record against the Conversation as it stands afterwards.
 */
async function runGenerationLifecycle<
	Accepted extends AcceptedGenerationTarget,
	Input extends PreviewableGenerationAttemptInput,
	Capture extends CapturedGeneration,
>(
	database: Database,
	input: Input,
	onAccepted: ((accepted: Accepted) => void | Promise<void>) | undefined,
	policy: GenerationLifecyclePolicy<Input, Capture, Accepted>,
): Promise<Accepted> {
	const conversation = createConversationModule(database);
	const revision = conversation.getRevision(input.conversationId);
	if (revision === undefined) throw new ConversationNotFoundError(input.conversationId);
	// ==[HUMAN APPROVED]== A revisioned lifecycle fails fast before the Prompt Plan is
	// compiled. The acceptance transaction re-checks the revision under its
	// own lock and stays authoritative; this only avoids budgeting a
	// Conversation that has already moved on.
	if (
		input.expectedRevision !== undefined &&
		revision !== input.expectedRevision
	) {
		throw new StaleConversationRevisionError(input.expectedRevision, revision);
	}
	const capture = await policy.capture(database, input.conversationId, input);
	generationRuntimeFor(database).assertAccepting();
	assertGenerationPlan(capture.plan);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = policy.accept(conversation, input, capture, timestamp);
	if (input.preview !== undefined) consumeGenerationPreview(database, input.preview.record);
	await notifyAccepted<Accepted>({ onAccepted }, accepted);
	return runAcceptedGeneration(input, policy.request(capture, input), {
		remove: () => {
			conversation.removeGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		},
		resolve: (outcome) => {
			conversation.checkpointGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				content: outcome.content,
				reasoning: outcome.reasoning,
			});
			const resolved = conversation.resolveGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				data: [
					...(policy.terminalData?.(capture) ?? []),
					...generationOutcomeData(outcome),
				],
			});
			return { ...accepted, conversation: resolved };
		},
	});
}

export interface SendThroughProvisionalTailGenerationInput extends GenerationAttemptInput {
	// ==[HUMAN APPROVED]== Send is a revisioned acceptance operation. The submitted text is
	// included in Prompt preflight before the server writes either Message.
	expectedRevision: number;
	content: string;
	/** ==[HUMAN APPROVED]== A server-owned pre-send capture with an optional direct plan edit. */
	preview?: GenerationPreviewAcceptanceFor<"send">;
	// ==[HUMAN APPROVED]== Fired immediately after the accepted human/provisional target
	// transaction commits and before provider contact begins.
	onAccepted?: (accepted: AcceptedTailGeneration) => void | Promise<void>;
}

/**
 * ==[HUMAN APPROVED]== A settled Generation is its acceptance record restated against the
 * Conversation as it stands after resolution. Acceptance already names the
 * Generation, its target Message, and its Provisional Variant, so a terminal
 * result carries nothing new but the newer snapshot — there is no separate
 * per-lifecycle result shape to map onto.
 */
export type SendThroughProvisionalTailGenerationResult = AcceptedTailGeneration;

// ==[HUMAN APPROVED]== Starts Send as a detached server-owned attempt. The caller receives an
// acceptance promise separately from the terminal result and may attach zero
// or more observers to the generation runtime in between. In particular, the
// caller's HTTP AbortSignal is intentionally not forwarded to the provider.
// The three entry points below exist to name their Accepted and Result types:
// the generic seam cannot infer them from an input literal alone.
export function startServerOwnedSendGeneration(
	database: Database,
	input: SendThroughProvisionalTailGenerationInput,
	callbacks: ServerOwnedGenerationCallbacks<AcceptedTailGeneration> = {},
): ServerOwnedGeneration<AcceptedTailGeneration, SendThroughProvisionalTailGenerationResult> {
	return startServerOwnedGenerationFrom(
		database,
		input,
		sendThroughProvisionalTailGeneration,
		callbacks,
	);
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
		capture: (currentDatabase, conversationId, current) => {
			if (current.preview !== undefined) {
				return Promise.resolve(captureSendGenerationPreview({
					database: currentDatabase,
					conversationId,
					preview: current.preview,
					content: current.content,
					connection: current.connection,
					connectionSettings: current.connectionSettings,
					formatting: current.formatting,
				}));
			}
			return captureSendGenerationAsync({
				database: currentDatabase,
				conversationId,
				content: current.content,
				connection: current.connection,
				connectionSettings: current.connectionSettings,
				tokenEstimator: current.tokenEstimator,
				formatting: current.formatting,
				preparationFetch: current.preparationFetch,
			});
		},
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
	});
}

export interface ContinueGenerationInput extends GenerationAttemptInput {
	// ==[HUMAN APPROVED]== Continue is a revisioned acceptance operation. The selected terminal
	// model Message and Variant are captured so a changed narrative position
	// cannot receive output from this attempt.
	expectedRevision: number;
	/** ==[HUMAN APPROVED]== A server-owned pre-send capture with an optional direct plan edit. */
	preview?: GenerationPreviewAcceptanceFor<"continuation">;
	onAccepted?: (accepted: AcceptedContinuationGeneration) => void | Promise<void>;
}

export type ContinueGenerationResult = AcceptedContinuationGeneration;

// ==[HUMAN APPROVED]== Continue starts from the selected narrative path and persists an ordinary
// model-authored Message. It shares the same normalized stream, terminal
// outcome, and provisional cleanup behavior as Send, but never inserts a
// Human-authored Message.
export async function continueGeneration(
	database: Database,
	input: ContinueGenerationInput,
): Promise<ContinueGenerationResult> {
	return runGenerationLifecycle(database, input, input.onAccepted, {
		capture: (currentDatabase, conversationId, current) => {
			if (current.preview !== undefined) {
				return Promise.resolve(captureContinuationGenerationPreview({
					database: currentDatabase,
					conversationId,
					preview: current.preview,
					connection: current.connection,
					connectionSettings: current.connectionSettings,
					formatting: current.formatting,
				}));
			}
			return captureContinuationGenerationAsync({
				database: currentDatabase,
				conversationId,
				connection: current.connection,
				connectionSettings: current.connectionSettings,
				tokenEstimator: current.tokenEstimator,
				formatting: current.formatting,
				preparationFetch: current.preparationFetch,
			});
		},
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
		terminalData: (capture) => [
			{ namespace: "generation", key: "intent", value: JSON.stringify(capture.intent) },
		],
	});
}

export function startServerOwnedContinuationGeneration(
	database: Database,
	input: ContinueGenerationInput,
	callbacks: ServerOwnedGenerationCallbacks<AcceptedContinuationGeneration> = {},
): ServerOwnedGeneration<AcceptedContinuationGeneration, ContinueGenerationResult> {
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
	/** ==[HUMAN APPROVED]== A server-owned pre-send capture with an optional direct plan edit. */
	preview?: GenerationPreviewAcceptanceFor<"sibling">;
	// ==[HUMAN APPROVED]== The provider-neutral Model Client receives the compiled Prompt Plan and
	// returns normalized asynchronous events for the sibling Variant.
	modelClient: ModelClient;
	connection?: ModelClientConnectionSnapshot | null;
	connectionSettings?: ConnectionSettingsModuleOptions;
	signal?: AbortSignal;
	onEvent?: (event: ModelClientEvent) => void | Promise<void>;
	onBeforeTerminal?: () => void | Promise<void>;
	onAccepted?: (accepted: AcceptedSiblingGeneration) => void | Promise<void>;
	tokenEstimator?: TokenEstimator;
	// ==[HUMAN APPROVED]== Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
	// ==[HUMAN APPROVED]== Initiating-client formatting context is captured once with the sibling attempt.
	formatting?: GenerationFormattingContext;
	preparationFetch?: import("../model-client/types").ModelFetch;
}

export type SiblingGenerationResult = AcceptedSiblingGeneration;

// ==[HUMAN APPROVED]== Targeted Swipe: generates a new sibling Variant for an existing native
// Message using the historical Control pair captured when that Message was
// generated or its openings were configured. The historical pair's current
// Definitions and names compile the plan; current generation settings and
// the selected history preceding the target Message complete it. The commit
// appends the sibling without changing current Control or the Author Stamp.
export async function generateSiblingVariant(
	database: Database,
	input: GenerateSiblingVariantInput,
): Promise<SiblingGenerationResult> {
	// ==[HUMAN APPROVED]== Sibling capture remains revision-neutral: the target's historical pair
	// and the sibling acceptance seam own its distinct eligibility and parallel-at-position rules.
	return runGenerationLifecycle(database, input, input.onAccepted, {
		capture: (currentDatabase, conversationId, current) => {
			if (current.preview !== undefined) {
				return Promise.resolve(captureSiblingGenerationPreview({
					database: currentDatabase,
					conversationId,
					preview: current.preview,
					messageId: current.messageId,
					connection: current.connection,
					connectionSettings: current.connectionSettings,
					formatting: current.formatting,
				}));
			}
			return captureSiblingGenerationAsync({
				database: currentDatabase,
				...current,
			});
		},
		accept: (conversation, current, capture, timestamp) => conversation.acceptSiblingGeneration({
			...capturedAcceptanceFields(capture, {
				conversationId: current.conversationId,
				timestamp,
			}),
			messageId: current.messageId,
			generationIntent: { type: "sibling" },
		}),
		request: modelRequestFor,
	});
}

// ==[HUMAN APPROVED]== Detached server-owned Sibling Generation. The acceptance promise resolves
// before provider contact so several attempts can be started and observed
// independently without coupling work to one HTTP subscriber.
export function startServerOwnedSiblingGeneration(
	database: Database,
	input: GenerateSiblingVariantInput,
	callbacks: ServerOwnedGenerationCallbacks<AcceptedSiblingGeneration> = {},
): ServerOwnedGeneration<AcceptedSiblingGeneration, SiblingGenerationResult> {
	return startServerOwnedGenerationFrom(
		database,
		input,
		generateSiblingVariant,
		callbacks,
	);
}
