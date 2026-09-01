import type { Static } from "@sinclair/typebox";
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
import { generationAccepted } from "../../shared/contract/conversation-schema";

type GenerationStartFailure =
	| { readonly status: 404; readonly body: { readonly outcome: "not-found" } }
	| { readonly status: 409; readonly body: { readonly outcome: "not-playable"; readonly reason: string } }
	| { readonly status: 409; readonly body: { readonly outcome: "conflict"; readonly reason: string } }
	| { readonly status: 422; readonly body: { readonly outcome: "invalid"; readonly reason: string } };

/**
 * ==[HUMAN APPROVED]== The responder maps a recognized failure onto its transport response.
 * The contract is total: a failure the route refuses to present to clients
 * (for example a stale-revision conflict on a route without a revision
 * input) is thrown as `UnexpectedGenerationStartFailure`, and the original
 * domain error is rethrown in its place so the framework's own 500 handling
 * stays intact.
 */
type GenerationStartFailureResponder<TResult> = (
	failure: GenerationStartFailure,
) => TResult;

// ==[HUMAN APPROVED]== Marker thrown by a responder for a failure outside its transport
// vocabulary; `generationAcceptanceResponse` never lets it reach a client.
export class UnexpectedGenerationStartFailure extends Error {
	constructor() {
		super("The Generation start failure is outside the route's acceptance contract.");
		this.name = "UnexpectedGenerationStartFailure";
	}
}

/**
 * ==[HUMAN APPROVED]== Map only errors that are part of the Generation acceptance contract. An
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
): TResult {
	const failure = generationStartFailure(error);
	// ==[HUMAN APPROVED]== An error outside the acceptance contract is never shaped into a
	// client-correctable response; the original error reaches the framework
	// unchanged.
	if (failure === undefined) throw error;
	try {
		return respond(failure);
	} catch (thrown) {
		if (thrown instanceof UnexpectedGenerationStartFailure) throw error;
		throw thrown;
	}
}

type AcceptedGenerationFields = {
	readonly generationId: number;
	readonly provisionalVariantId: number;
};

// ==[HUMAN APPROVED]== The accepted body derives from the canonical generationAccepted
// wire schema (ADR-0032) so the acceptance response can never drift from the
// transport contract.
type AcceptedGenerationBody = Static<typeof generationAccepted>;

/**
 * ==[HUMAN APPROVED]== Shared acceptance seam for Send, Continue, and Sibling starts. The caller
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
		return generationStartFailureResponse(error, respond);
	}
}
