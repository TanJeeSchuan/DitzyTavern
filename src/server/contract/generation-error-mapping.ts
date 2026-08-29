import {
	ConversationNotFoundError,
	ConversationNotPlayableError,
	ContinuationUnavailableError,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	StaleConversationRevisionError,
} from "../conversation";
import { GenerationConfigurationError } from "../application/generation-coordinator";
import { PromptBudgetExceededError } from "../prompt-compiler";

type GenerationStartFailure =
	| { readonly status: 404; readonly body: { readonly outcome: "not-found" } }
	| { readonly status: 409; readonly body: { readonly outcome: "not-playable"; readonly reason: string } }
	| { readonly status: 409; readonly body: { readonly outcome: "conflict"; readonly reason: string } }
	| { readonly status: 422; readonly body: { readonly outcome: "invalid"; readonly reason: string } };

type GenerationStartFailureResponder<TResult> = (
	failure: GenerationStartFailure,
) => TResult | undefined;

/**
 * Map only errors that are part of the Generation acceptance contract. An
 * unexpected Error must reach the framework's 500 handling instead of being
 * presented as a client-correctable invalid request.
 */
const generationStartFailure = (error: Error): GenerationStartFailure | undefined => {
	if (error instanceof ConversationNotFoundError) {
		return { status: 404, body: { outcome: "not-found" } };
	}
	if (error instanceof ConversationNotPlayableError) {
		return { status: 409, body: { outcome: "not-playable", reason: error.message } };
	}
	if (error instanceof StaleConversationRevisionError) {
		return { status: 409, body: { outcome: "conflict", reason: error.message } };
	}
	if (
		error instanceof ContinuationUnavailableError ||
		error instanceof GenerationConfigurationError ||
		error instanceof InvalidConversationCommandError ||
		error instanceof PromptBudgetExceededError ||
		error instanceof SiblingVariantUnavailableError
	) {
		return { status: 422, body: { outcome: "invalid", reason: error.message } };
	}
	return undefined;
};

function generationStartFailureResponse<TResult>(
	error: Error,
	respond: GenerationStartFailureResponder<TResult>,
): TResult | undefined {
	const failure = generationStartFailure(error);
	return failure === undefined ? undefined : respond(failure);
}

type AcceptedGenerationFields = {
	readonly generationId: number;
	readonly provisionalVariantId: number;
};

type AcceptedGenerationBody = {
	readonly outcome: "accepted";
	readonly generationId: number;
	readonly conversationId: number;
	readonly messageId: number;
	readonly variantId: number;
};

/**
 * Shared acceptance seam for Send, Continue, and Sibling starts. The caller
 * supplies only the coordinator start and the field that identifies its
 * target Message; recognized failures receive the same HTTP mapping.
 */
export async function generationAcceptanceResponse<
	TAccepted extends AcceptedGenerationFields,
	TFailureResponse,
>(
	conversationId: number,
	start: () => Promise<{ readonly accepted: TAccepted }>,
	messageId: (accepted: TAccepted) => number,
	respond: GenerationStartFailureResponder<TFailureResponse>,
): Promise<AcceptedGenerationBody | TFailureResponse> {
	try {
		const started = await start();
		const accepted = started.accepted;
		return {
			outcome: "accepted",
			generationId: accepted.generationId,
			conversationId,
			messageId: messageId(accepted),
			variantId: accepted.provisionalVariantId,
		};
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const failureResponse = generationStartFailureResponse(error, respond);
		if (failureResponse !== undefined) return failureResponse;
		throw error;
	}
}
