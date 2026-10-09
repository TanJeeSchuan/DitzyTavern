import { api } from "./lib/eden";
import { requestOutcome } from "./lib/request-outcome";
import { clientFormattingContext } from "./lib/formatting-context";
import { nativeConversationResponse } from "../shared/contract/native-conversation";
import { characterCommandErrors } from "../shared/contract/character-library";
import type { PromptChannels } from "../shared/contract/prompt-schema";
import { emptyPromptChannels } from "../shared/definition";

// @approved
// Typed client for the native New Chat workflow. Outcomes mirror the
// server's typed results so setup problems (stale fork sources, invalid
// Definitions) surface without losing the user's draft.

export type SeatDraft =
	| {
			type: "character";
			characterId: number;
			expectedRevision: number;
	  }
	| {
			type: "adhoc";
			definition: {
				name: string;
				prompt: PromptChannels;
				openings: string[];
			};
	  };

// @approved
// The native-creation route's outcome is the wire's own: the created
//  Conversation under `available`, the typed 409/404/422 envelopes verbatim,
// network when the transport could not complete the request, and the shared
// invalid fallback when the response could not be read.
export type CreationOutcome = Awaited<ReturnType<typeof createNativeConversation>>;

export const emptySeatDraft = (): Extract<SeatDraft, { type: "adhoc" }> => ({
	type: "adhoc",
	definition: { name: "", prompt: emptyPromptChannels(), openings: [] },
});

export async function createNativeConversation(input: {
	name: string;
	humanSeat: SeatDraft;
	modelSeat: SeatDraft;
	timeZone?: string;
	locale?: string;
}) {
	const formatting = clientFormattingContext(input);
	return requestOutcome(
		api.api.conversations.native.post({
			name: input.name,
			humanSeat: input.humanSeat,
			modelSeat: input.modelSeat,
			...formatting,
		}),
		nativeConversationResponse,
		characterCommandErrors,
	);
}
