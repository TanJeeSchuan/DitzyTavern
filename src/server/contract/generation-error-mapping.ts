import type { Static } from "@sinclair/typebox";
import {
	generationAccepted,
	generationConflictResponse,
} from "../../shared/contract/conversation-schema";
import { invalidOutcome, notFoundOutcome, notPlayableOutcome } from "../../shared/contract/outcomes";
import { presentDomainError, type DomainErrorResponse } from "./domain-error";

const generationErrors = {
	404: notFoundOutcome,
	409: generationConflictResponse,
	422: invalidOutcome,
};
const siblingErrors = { ...generationErrors, 409: notPlayableOutcome };

type AcceptedGenerationFields = {
	readonly generationId: number;
	readonly messageId: number;
	readonly provisionalVariantId: number;
};
type AcceptedGenerationBody = Static<typeof generationAccepted>;

async function acceptanceResponse<S extends typeof generationErrors | typeof siblingErrors>(
	conversationId: number,
	start: () => Promise<{ readonly accepted: AcceptedGenerationFields }>,
	errors: S,
): Promise<AcceptedGenerationBody | DomainErrorResponse<S>> {
	try {
		const { accepted } = await start();
		return {
			outcome: "accepted",
			generationId: accepted.generationId,
			conversationId,
			messageId: accepted.messageId,
			variantId: accepted.provisionalVariantId,
		};
	} catch (error) {
		return presentDomainError(error, errors);
	}
}

export const generationAcceptanceResponse = (
	conversationId: number,
	start: () => Promise<{ readonly accepted: AcceptedGenerationFields }>,
) => acceptanceResponse(conversationId, start, generationErrors);

export const siblingGenerationAcceptanceResponse = (
	conversationId: number,
	start: () => Promise<{ readonly accepted: AcceptedGenerationFields }>,
) => acceptanceResponse(conversationId, start, siblingErrors);
