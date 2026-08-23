import { api } from "./lib/eden";

// Typed client for the native New Chat workflow. Outcomes mirror the
// server's typed results so setup problems (stale fork sources, invalid
// Definitions) surface without losing the user's draft.

export interface SeatPromptDraft {
	systemInstruction: string;
	identity: string;
	scenario: string;
	exampleDialogue: string;
	postHistoryInstruction: string;
}

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
				prompt: SeatPromptDraft;
				openings: string[];
			};
	  };

export type CreationOutcome =
	| { status: "created"; conversationId: number; playable: boolean }
	| { status: "conflict"; currentCharacterName: string }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

const emptyPrompt = (): SeatPromptDraft => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

export const emptySeatDraft = (): Extract<SeatDraft, { type: "adhoc" }> => ({
	type: "adhoc",
	definition: { name: "", prompt: emptyPrompt(), openings: [] },
});

export async function createNativeConversation(input: {
	name: string;
	humanSeat: SeatDraft;
	modelSeat: SeatDraft;
}): Promise<CreationOutcome> {
	const { data, error } = await api.api.conversations.native.post({
		name: input.name,
		humanSeat: input.humanSeat,
		modelSeat: input.modelSeat,
	});
	if (error) {
		const payload = error.value;
		if (payload.outcome === "conflict") {
			return {
				status: "conflict",
				currentCharacterName:
					payload.currentCharacter?.name ?? "the Character",
			};
		}
		if (payload.outcome === "not-found") {
			return { status: "not-found" };
		}
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: String(payload.reason ?? "") };
		}
		return { status: "network" };
	}
	return {
		status: "created",
		conversationId: data.conversation.id,
		playable: data.conversation.playable,
	};
}
