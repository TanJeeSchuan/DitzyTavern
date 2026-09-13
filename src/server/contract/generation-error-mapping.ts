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

// ==[HUMAN APPROVED]== The response union Send and Continue present: every recognized failure.
export type GenerationStartFailureResponse = FailureResponseOf<GenerationStartFailure>;

// ==[HUMAN APPROVED]== The response union Sibling starts present: stale-revision conflicts
// are declined (the route has no revision input), so the 409 response
// carries only the not-playable body the sibling schema declares.
export type SiblingGenerationStartFailureResponse = FailureResponseOf<
	Exclude<GenerationStartFailure, { status: 409; body: { outcome: "conflict" } }>
>;

/**
 * ==[HUMAN APPROVED]== Map only errors that are part of the Generation acceptance contract. An
 * unexpected Error must reach the framework's 500 handling instead of being
 * presented as a client-correctable invalid request.
 */
export const classifyGenerationFailure = (error: Error): GenerationStartFailure | undefined => {
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

// ==[HUMAN APPROVED]== Send and Continue present every recognized failure as its own status.
const presentGenerationStartFailure = (
	failure: GenerationStartFailure,
): GenerationStartFailureResponse => {
	if (failure.status === 404) return status(404, failure.body);
	if (failure.status === 409) return status(409, failure.body);
	return status(422, failure.body);
};

// ==[HUMAN APPROVED]== Sibling starts have no revision input, so a stale-revision conflict is
// not part of their vocabulary: the original domain error reaches the
// framework's 500 handling unchanged instead of becoming a client-correctable
// response.
const presentSiblingGenerationStartFailure = (
	failure: GenerationStartFailure,
	error: Error,
): SiblingGenerationStartFailureResponse => {
	if (failure.status === 409) {
		if (failure.body.outcome === "conflict") throw error;
		return status(409, failure.body);
	}
	if (failure.status === 404) return status(404, failure.body);
	return status(422, failure.body);
};

type AcceptedGenerationFields = {
	readonly generationId: number;
	// ==[HUMAN APPROVED]== The Message the Provisional Variant belongs to: a new model Message
	// for Send and Continue, the existing target for a Sibling.
	readonly messageId: number;
	readonly provisionalVariantId: number;
};

// ==[HUMAN APPROVED]== The accepted body derives from the canonical generationAccepted
// wire schema (ADR-0032) so the acceptance response can never drift from the
// transport contract.
type AcceptedGenerationBody = Static<typeof generationAccepted>;

/**
 * ==[HUMAN APPROVED]== Shared acceptance seam for Send, Continue, and Sibling starts. The caller
 * supplies only the coordinator start and how its route presents a recognized
 * failure; an error outside the acceptance contract reaches the framework
 * unchanged.
 */
async function acceptanceResponse<
	TAccepted extends AcceptedGenerationFields,
	TFailureResponse,
>(
	conversationId: number,
	start: () => Promise<{ readonly accepted: TAccepted }>,
	present: (failure: GenerationStartFailure, error: Error) => TFailureResponse,
): Promise<AcceptedGenerationBody | TFailureResponse> {
	try {
		const started = await start();
		const accepted = started.accepted;
		return {
			outcome: "accepted",
			generationId: accepted.generationId,
			conversationId,
			messageId: accepted.messageId,
			variantId: accepted.provisionalVariantId,
		};
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const failure = classifyGenerationFailure(error);
		// ==[HUMAN APPROVED]== An error outside the acceptance contract is never shaped into a
		// client-correctable response; the original error reaches the framework
		// unchanged.
		if (failure === undefined) throw error;
		return present(failure, error);
	}
}

export function generationAcceptanceResponse<TAccepted extends AcceptedGenerationFields>(
	conversationId: number,
	start: () => Promise<{ readonly accepted: TAccepted }>,
): Promise<AcceptedGenerationBody | GenerationStartFailureResponse> {
	return acceptanceResponse(conversationId, start, presentGenerationStartFailure);
}

export function siblingGenerationAcceptanceResponse<TAccepted extends AcceptedGenerationFields>(
	conversationId: number,
	start: () => Promise<{ readonly accepted: TAccepted }>,
): Promise<AcceptedGenerationBody | SiblingGenerationStartFailureResponse> {
	return acceptanceResponse(conversationId, start, presentSiblingGenerationStartFailure);
}
