import { api } from "./lib/eden";
import { commandOutcome } from "./lib/command-outcome";
import { withInlineImages } from "./lib/image";
import type {
	CharacterCommand,
	CharacterDeletionImpact,
	CharacterDeletionMode,
	CharacterDeletionResult,
	CharacterLibrarySummary as CharacterSummary,
	CharacterSnapshot,
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

export type CommandOutcome =
	| { status: "applied"; character: CharacterSnapshot }
	// A confirmed deletion returns the derived mode instead of a snapshot:
	// ==[HUMAN APPROVED]== neither a hard-deleted nor a tombstoned Character remains readable.
	| { status: "deleted"; result: CharacterDeletionResult }
	| { status: "conflict"; currentCharacter: CharacterSnapshot }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

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
): Promise<CommandOutcome> {
	const { data, error } = await withInlineImages(JSON.stringify(command), (images) =>
		api.api.characters.commands.post(command.type === "create" || command.type === "update-definition" ? { ...command, images } : command),
	);
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({ status: "conflict", currentCharacter: payload.currentCharacter }),
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	// Deletion returns the typed result instead of a snapshot; every other
	// ==[HUMAN APPROVED]== command returns the authoritative updated Character. The payload is a
	// union discriminated by the result-only `result` field.
	if ("result" in data) {
		return { status: "deleted", result: data.result };
	}
	return { status: "applied", character: data.character };
}
