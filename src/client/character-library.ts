import { api } from "./lib/eden";
import { requestOutcome } from "./lib/request-outcome";
import {
	characterCommandApplied,
	characterCommandErrors,
	type CharacterCommand,
	type CharacterDeletionImpact,
	type CharacterDeletionMode,
	type CharacterDeletionResult,
	type CharacterLibrarySummary as CharacterSummary,
	type CharacterSnapshot,
} from "../shared/contract/character-library";

// ==[HUMAN APPROVED]== Typed client for the Character Library transport adapters. Outcomes mirror
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

// The Character command route's outcome is the wire's own: the applied
// ==[HUMAN APPROVED]== response (applied snapshot or derived deletion result) under `available`,
// the typed 409/404/422 envelopes verbatim, and network for everything the
// seam could not classify.
export type CommandOutcome = Awaited<ReturnType<typeof applyCommand>>;

export async function listCharacters(): Promise<CharacterSummary[]> {
	const { data, error } = await api.api.characters.get();
	if (error || !data) {
		throw new Error("Unable to list Characters");
	}
	return data.characters;
}

export async function getCharacter(
	characterId: number,
): Promise<CharacterSnapshot | null> {
	const { data, error } = await api.api.characters({ id: characterId }).get();
	if (error !== null && error !== undefined) {
		if (error.status === 404) {
			return null;
		}
		throw new Error(`Unable to load Character ${characterId}`);
	}
	return data ?? null;
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
