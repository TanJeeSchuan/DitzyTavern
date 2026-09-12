import { api } from "./lib/eden";
import { commandOutcome } from "./lib/command-outcome";
import { clientFormattingContext } from "./lib/formatting-context";
import { decodeWirePayload } from "./lib/wire-decode";
import type { PromptChannels } from "../shared/contract/prompt-schema";
import { nativeConversationResponse } from "../shared/contract/native-conversation";
import { emptyPromptChannels } from "../shared/definition";

// Typed client for the native New Chat workflow. Outcomes mirror the ==[HUMAN APPROVED]==
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

export type CreationOutcome =
	| { status: "created"; conversationId: number; playable: boolean }
	| { status: "conflict"; currentCharacterName: string }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

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
}): Promise<CreationOutcome> {
	const formatting = clientFormattingContext(input);
	const { data, error } = await api.api.conversations.native.post({
		name: input.name,
		humanSeat: input.humanSeat,
		modelSeat: input.modelSeat,
		...formatting,
	});
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({
				status: "conflict",
				currentCharacterName:
					payload.currentCharacter?.name ?? "the Character",
			}),
			invalid: (payload) => ({ status: "invalid", reason: String(payload.reason ?? "") }),
		});
	}
	const response = decodeWirePayload(nativeConversationResponse, data);
	return response === null
		? { status: "network" }
		: {
				status: "created",
				conversationId: response.conversation.id,
				playable: response.conversation.playable,
			};
}
