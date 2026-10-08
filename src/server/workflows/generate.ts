// @approved
//  Server-owned Generation workflows.
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
// The transport is injected as a seam: this module stays independent of any
// concrete provider, streaming protocol, or credentials.
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
import type {
	ModelClientGenerationInput,
} from "../model-client";
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
	captureGeneration,
	capturedAcceptanceFields,
	modelRequestFor,
	type CapturedGenerationFor,
} from "./generate-capture";
import {
	consumeGenerationPreview,
	captureGenerationPreview,
	type GenerationPreviewAcceptanceFor,
} from "./generation-preview";
import {
	assertGenerationPlan,
} from "../generation-plan";
import type {
	GenerationTargetFor,
	GenerationTargetKind,
} from "../../shared/contract/conversation-schema";

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
		// @approved
		//  Acceptance is authoritative even when an observing caller disconnects.
	}
}

// @approved
//  What acceptance must report for the runner to finish a Generation
// without asking the lifecycle anything further.
interface AcceptedGenerationTarget {
	generationId: number;
	conversation: ConversationSummary;
}

/**
 * ==[HUMAN APPROVED]== The one lifecycle policy of one attempt kind: what its capture targets,
 * how it accepts into the Conversation, and what it asks the provider for.
 * The runner owns everything else, so the rows differ only where Send,
 * Continue, and Sibling genuinely differ.
 */
interface GenerationLifecyclePolicy<
	K extends GenerationTargetKind,
	Input extends GenerationAttemptInput,
	Accepted extends AcceptedGenerationTarget,
> {
	// @approved
	//  The attempt target this lifecycle starts, on the one Generation
	// Target union.
	target: (input: Input) => GenerationTargetFor<K>;
	accept: (
		conversation: ConversationModule,
		input: Input,
		capture: CapturedGenerationFor<K>,
		timestamp: string,
	) => Accepted;
	request: (
		capture: CapturedGenerationFor<K>,
		input: Input,
	) => ModelClientGenerationInput;
	// @approved
	//  Terminal Conversation data particular to this lifecycle, recorded
	// ahead of the shared outcome entries. Only Continue has any.
	terminalData?: (capture: CapturedGenerationFor<K>) => readonly ConversationDataEntry[];
}

/**
 * ==[HUMAN APPROVED]== Run one server-owned Generation lifecycle from the shared seams.
 * What differs between Send, Continue, and Sibling is in the lifecycle
 * policy; the runner owns the rest. Resolution does not differ: the runner
 * commits the terminal outcome and reports the acceptance record against the
 * Conversation as it stands afterwards.
 */
async function runGenerationLifecycle<
	K extends GenerationTargetKind,
	Input extends GenerationAttemptInput & {
		readonly preview?: GenerationPreviewAcceptanceFor<K>;
		// @approved
		//  Fired immediately after the accepted target transaction commits
		// and before provider contact begins.
		readonly onAccepted?: (accepted: Accepted) => void | Promise<void>;
	},
	Accepted extends AcceptedGenerationTarget,
>(
	database: Database,
	input: Input,
	policy: GenerationLifecyclePolicy<K, Input, Accepted>,
): Promise<Accepted> {
	const conversation = createConversationModule(database);
	const revision = conversation.getRevision(input.conversationId);
	if (revision === undefined) throw new ConversationNotFoundError(input.conversationId);
	// @approved
	//  A revisioned lifecycle fails fast before the Prompt Plan is
	// compiled. The acceptance transaction re-checks the revision under its
	// own lock and stays authoritative; this only avoids budgeting a
	// Conversation that has already moved on.
	if (
		input.expectedRevision !== undefined &&
		revision !== input.expectedRevision
	) {
		throw new StaleConversationRevisionError(input.expectedRevision, revision);
	}
	const target = policy.target(input);
	let capture: CapturedGenerationFor<K>;
	if (input.preview === undefined) {
		capture = await captureGeneration(database, target, input);
	} else {
		// @approved
		//  SAFETY: each lifecycle entry point binds its preview
		// acceptance and its target to the same attempt kind, so the captured
		// Generation of the accepted preview is the capture member of that kind.
		capture = captureGenerationPreview(
			{
				database,
				conversationId: input.conversationId,
				connection: input.connection,
				connectionSettings: input.connectionSettings,
				formatting: input.formatting,
			},
			input.preview,
			target,
		) as CapturedGenerationFor<K>;
	}
	generationRuntimeFor(database).assertAccepting();
	assertGenerationPlan(capture.plan);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = policy.accept(conversation, input, capture, timestamp);
	if (input.preview !== undefined) consumeGenerationPreview(database, input.preview.record);
	await notifyAccepted<Accepted>({ onAccepted: input.onAccepted }, accepted);
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
	// @approved
	//  Send is a revisioned acceptance operation. The submitted text is
	// included in Prompt preflight before the server writes either Message.
	expectedRevision: number;
	content: string;
	/** ==[HUMAN APPROVED]== A server-owned pre-send capture with an optional direct plan edit. */
	preview?: GenerationPreviewAcceptanceFor<"send">;
	// @approved
	//  Fired immediately after the accepted human/provisional target
	// transaction commits and before provider contact begins.
	onAccepted?: (accepted: AcceptedTailGeneration) => void | Promise<void>;
}

// @approved
//  The one lifecycle policy table, one row per attempt kind. Each row
// states only where its kind genuinely differs: the attempt target it starts,
// how it accepts into the Conversation, and (Continuation only) the terminal
// data recorded ahead of the shared outcome entries.
const generationLifecyclePolicies = {
	send: {
		target: (input: SendThroughProvisionalTailGenerationInput) => ({ kind: "send", content: input.content }),
		// @approved
		//  Send's accepted lifecycle: preflight is entirely read-only; only
		// after it succeeds does the Conversation seam atomically create the human
		// input, provisional model target, and Active Generation before this
		// workflow contacts a Model Client.
		accept: (
			conversation: ConversationModule,
			input: SendThroughProvisionalTailGenerationInput,
			capture: CapturedGenerationFor<"send">,
			timestamp: string,
		) => conversation.acceptTailGeneration({
			...capturedAcceptanceFields(capture, {
				conversationId: input.conversationId,
				timestamp,
			}),
			expectedRevision: input.expectedRevision,
			humanContent: capture.content,
			reuseHumanMessageId: capture.reuseHumanMessageId,
		}),
		request: modelRequestFor,
	} satisfies GenerationLifecyclePolicy<"send", SendThroughProvisionalTailGenerationInput, AcceptedTailGeneration>,
	continuation: {
		target: () => ({ kind: "continuation" }),
		accept: (
			conversation: ConversationModule,
			input: ContinueGenerationInput,
			capture: CapturedGenerationFor<"continuation">,
			timestamp: string,
		) => conversation.acceptContinuationGeneration({
			...capturedAcceptanceFields(capture, {
				conversationId: input.conversationId,
				timestamp,
			}),
			expectedRevision: input.expectedRevision,
			precedingMessageId: capture.precedingMessageId,
			precedingVariantId: capture.precedingVariantId,
			generationIntent: capture.intent,
		}),
		request: modelRequestFor,
		terminalData: (capture: CapturedGenerationFor<"continuation">) => [
			{ namespace: "generation", key: "intent", value: JSON.stringify(capture.intent) },
		],
	} satisfies GenerationLifecyclePolicy<"continuation", ContinueGenerationInput, AcceptedContinuationGeneration>,
	sibling: {
		target: (input: GenerateSiblingVariantInput) => ({ kind: "sibling", messageId: input.messageId }),
		accept: (
			conversation: ConversationModule,
			input: GenerateSiblingVariantInput,
			capture: CapturedGenerationFor<"sibling">,
			timestamp: string,
		) => conversation.acceptSiblingGeneration({
			...capturedAcceptanceFields(capture, {
				conversationId: input.conversationId,
				timestamp,
			}),
			messageId: capture.messageId,
			generationIntent: { type: "sibling" },
		}),
		request: modelRequestFor,
	} satisfies GenerationLifecyclePolicy<"sibling", GenerateSiblingVariantInput, AcceptedSiblingGeneration>,
};

// @approved
//  Send workflow: the accepted human/provisional target is committed
// atomically and the provider attempt runs detached from any observing
// request. Each entry names its kind and delegates to the one lifecycle
// runner with its row of the one policy table.
export type SendThroughProvisionalTailGenerationResult = AcceptedTailGeneration;

export async function sendThroughProvisionalTailGeneration(
	database: Database,
	input: SendThroughProvisionalTailGenerationInput,
): Promise<SendThroughProvisionalTailGenerationResult> {
	return runGenerationLifecycle(database, input, generationLifecyclePolicies.send);
}

export interface ContinueGenerationInput extends GenerationAttemptInput {
	// @approved
	//  Continue is a revisioned acceptance operation. The selected terminal
	// model Message and Variant are captured so a changed narrative position
	// cannot receive output from this attempt.
	expectedRevision: number;
	/** ==[HUMAN APPROVED]== A server-owned pre-send capture with an optional direct plan edit. */
	preview?: GenerationPreviewAcceptanceFor<"continuation">;
	onAccepted?: (accepted: AcceptedContinuationGeneration) => void | Promise<void>;
}

export type ContinueGenerationResult = AcceptedContinuationGeneration;

// @approved
//  Continue starts from the selected narrative path and persists an ordinary
// model-authored Message. It shares the same normalized stream, terminal
// outcome, and provisional cleanup behavior as Send, but never inserts a
// Human-authored Message.
export async function continueGeneration(
	database: Database,
	input: ContinueGenerationInput,
): Promise<ContinueGenerationResult> {
	return runGenerationLifecycle(database, input, generationLifecyclePolicies.continuation);
}

export interface GenerateSiblingVariantInput extends GenerationAttemptInput {
	// @approved
	//  The target Message whose captured historical Control pair governs this
	// sibling generation. Current Control is deliberately ignored: Swiping an
	// older Message reproduces the participants who were playing when it was
	// generated, and never reassigns the seats.
	messageId: number;
	/** ==[HUMAN APPROVED]== A server-owned pre-send capture with an optional direct plan edit. */
	preview?: GenerationPreviewAcceptanceFor<"sibling">;
	// @approved
	//  Fired immediately after the accepted sibling target transaction
	// commits and before provider contact begins.
	onAccepted?: (accepted: AcceptedSiblingGeneration) => void | Promise<void>;
}

export type SiblingGenerationResult = AcceptedSiblingGeneration;

// @approved
//  Targeted Swipe: generates a new sibling Variant for an existing native
// Message using the historical Control pair captured when that Message was
// generated or its openings were configured. The historical pair's current
// Definitions and names compile the plan; current generation settings and
// the selected history preceding the target Message complete it. The commit
// appends the sibling without changing current Control or the Author Stamp.
// Sibling capture remains revision-neutral: the target's historical pair and
// the sibling acceptance seam own its distinct eligibility and
// parallel-at-position rules.
export async function generateSiblingVariant(
	database: Database,
	input: GenerateSiblingVariantInput,
): Promise<SiblingGenerationResult> {
	return runGenerationLifecycle(database, input, generationLifecyclePolicies.sibling);
}

/**
 * ==[HUMAN APPROVED]== The one detached server-owned start. Acceptance is exposed separately so
 * an HTTP caller can return as soon as the provisional target exists; the
 * caller's HTTP AbortSignal is intentionally not forwarded to the provider.
 * The attempt kind dispatches on the attempt input's own fields: Send carries
 * the submitted text, Sibling the target Message, and Continue neither.
 */
export function startServerOwnedGeneration(
	database: Database,
	input: GenerationStartInput,
	callbacks: ServerOwnedGenerationCallbacks<AcceptedGenerationRecord> = {},
): ServerOwnedGeneration<AcceptedGenerationRecord, AcceptedGenerationRecord> {
	return startServerOwnedGenerationFrom(
		database,
		// @approved
		//  SAFETY: the dispatch below routes the whole input to exactly one
		// lifecycle, and that lifecycle invokes acceptance only with its own
		// accepted record, so the union input's narrower acceptance callback is
		// sound by construction.
		input as GenerationStartInput & {
			onAccepted?: (accepted: AcceptedGenerationRecord) => void | Promise<void>;
		},
		async (currentDatabase, current) => {
			if ("content" in current) return sendThroughProvisionalTailGeneration(currentDatabase, current);
			if ("messageId" in current) return generateSiblingVariant(currentDatabase, current);
			return continueGeneration(currentDatabase, current);
		},
		callbacks,
	);
}

/** ==[HUMAN APPROVED]== The one Generation start input every detached attempt takes. */
export type GenerationStartInput =
	| SendThroughProvisionalTailGenerationInput
	| ContinueGenerationInput
	| GenerateSiblingVariantInput;

/** ==[HUMAN APPROVED]== The accepted record every detached attempt exposes, whatever its kind. */
export type AcceptedGenerationRecord =
	| AcceptedTailGeneration
	| AcceptedContinuationGeneration
	| AcceptedSiblingGeneration;
