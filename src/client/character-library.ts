import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/eden";
import { foundOrNull, requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import {
	characterCommandResponse,
	characterListResponse,
	characterReadResponse,
	type CharacterCommand,
	type CharacterDeletionImpact,
	type CharacterDeletionMode,
	type CharacterLibrarySummary as CharacterSummary,
	type CharacterSnapshot,
} from "../shared/contract/character-library";

// @approved
//  Typed client for the Character Library transport adapters. Outcomes mirror
// the server's typed results so the UI can recover from conflicts without
// losing local drafts. Every Character shape is the canonical shared wire
// schema's Static type, imported under the client's historical names so the
// client can never drift from the server.

export type {
	CharacterCommand,
	CharacterDeletionImpact,
	CharacterDeletionMode,
	CharacterSnapshot,
	CharacterSummary,
};

export const charactersQuery = queryOptions({
	queryKey: ["characters"],
	queryFn: async ({ signal }) =>
		(await requestData(api.api.characters.get({ fetch: { signal } }), characterListResponse[200])).characters,
});

export async function getCharacter(
	characterId: number,
): Promise<CharacterSnapshot | null> {
	return foundOrNull(await requestOutcome(api.api.characters({ id: characterId }).get(), characterReadResponse));
}

export function useCharacterCommand() {
	const client = useQueryClient();
	return async (command: CharacterCommand) => {
		const outcome = await requestOutcome(api.api.characters.commands.post(command), characterCommandResponse);
		if (outcome.outcome === "available" || outcome.outcome === "conflict" || outcome.outcome === "not-found") {
			void client.invalidateQueries({ queryKey: charactersQuery.queryKey });
		}
		return outcome;
	};
}

export const LIBRARY_UNREACHABLE_NOTICE = "The Library could not be reached.";
