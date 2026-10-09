import { api } from "./lib/eden";
import { NetworkError, SERVER_UNREACHABLE_NOTICE, requestData, requestOutcome } from "./lib/request-outcome";
import {
	characterCommandApplied,
	characterCommandErrors,
	characterListResponse,
	characterSnapshot,
	type CharacterCommand,
	type CharacterDeletionImpact,
	type CharacterDeletionMode,
	type CharacterDeletionResult,
	type CharacterLibrarySummary as CharacterSummary,
	type CharacterSnapshot,
} from "../shared/contract/character-library";
import { notFoundOutcome } from "../shared/contract/outcomes";

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
	CharacterDeletionResult,
	CharacterSnapshot,
	CharacterSummary,
};

// @approved
// The Character command route's outcome is the wire's own: the applied
//  response (applied snapshot or derived deletion result) under `available`,
// the typed 409/404/422 envelopes verbatim, network when the transport could
// not complete the request, and the shared invalid fallback when the response
// could not be read.
export type CommandOutcome = Awaited<ReturnType<typeof applyCommand>>;

export async function listCharacters(): Promise<CharacterSummary[]> {
	return (await requestData(api.api.characters.get(), characterListResponse)).characters;
}

export async function getCharacter(
	characterId: number,
): Promise<CharacterSnapshot | null> {
	const outcome = await requestOutcome(api.api.characters({ id: characterId }).get(), characterSnapshot, notFoundOutcome);
	if (outcome.outcome === "not-found") return null;
	if (outcome.outcome === "network") throw new NetworkError(SERVER_UNREACHABLE_NOTICE);
	if (outcome.outcome === "invalid") throw new Error(outcome.reason);
	return outcome.value;
}

export async function applyCommand(
	command: CharacterCommand,
) {
	return requestOutcome(
		api.api.characters.commands.post(command),
		characterCommandApplied,
		characterCommandErrors,
	);
}

export const LIBRARY_UNREACHABLE_NOTICE = "The Library could not be reached.";
