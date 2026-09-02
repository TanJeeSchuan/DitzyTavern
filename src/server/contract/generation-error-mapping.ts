import type { Static } from "@sinclair/typebox";
import { status } from "elysia";
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

// ==[HUMAN APPROVED]== The typed transport response for a set of recognized failures: one
// status response per failure status the set covers, with that status's
// allowed bodies. Derived from the failure vocabulary so the responder
// annotations below can never drift from it.
type FailureResponseOf<F extends GenerationStartFailure> =
	| ReturnType<typeof status<404, Extract<F, { status: 404 }>["body"]>>
	| ReturnType<typeof status<409, Extract<F, { status: 409 }>["body"]>>
	| ReturnType<typeof status<422, Extract<F, { status: 422 }>["body"]>>;

// ==[HUMAN APPROVED]== A responder's verdict: the mapped transport response, or a refusal
// for a failure outside its route's vocabulary.
export type ResponderOutcome<TResult> =
	| { readonly present: true; readonly response: TResult }
	| { readonly present: false };

// ==[HUMAN APPROVED]== The response union Send and Continue present: every recognized
// failure. Responders annotate their outcome with it explicitly, because
// TypeScript infers only the first arm of a multi-arm responder union.
export type GenerationStartFailureResponse = FailureResponseOf<GenerationStartFailure>;

// ==[HUMAN APPROVED]== The response union Sibling starts present: stale-revision conflicts
// are declined (the route has no revision input), so the 409 response
// carries only the not-playable body the sibling schema declares.
export type SiblingGenerationStartFailureResponse = FailureResponseOf<
	Exclude<GenerationStartFailure, { status: 409; body: { outcome: "conflict" } }>
>;

/**
 * ==[HUMAN APPROVED]== The responder maps a recognized failure onto its transport response.
 * The contract is a typed sum: a responder either presents a response or
 * declines to present the failure (`{ present: false }`), in which case the
 * original domain error reaches the framework's own 500 handling unchanged.
 */
type GenerationStartFailureResponder<TResult> = (
	failure: GenerationStartFailure,
) => ResponderOutcome<TResult>;

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
	const outcome = respond(failure);
	// ==[HUMAN APPROVED]== A responder that declines the mapping (a failure outside its route's
	// vocabulary) lets the original domain error reach the framework unchanged.
	if (!outcome.present) throw error;
	return outcome.response;
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
