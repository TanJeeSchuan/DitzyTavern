import { api } from "./lib/eden";

// Typed client for the Character Library transport adapters. Outcomes mirror
// the server's typed results so the UI can recover from conflicts without
// losing local drafts.

export interface CharacterPrompt {
	systemInstruction: string;
	identity: string;
	scenario: string;
	exampleDialogue: string;
	postHistoryInstruction: string;
}

export interface CharacterSummary {
	id: number;
	name: string;
	revision: number;
	pinned: boolean;
}

export interface CharacterSnapshot {
	id: number;
	name: string;
	revision: number;
	pinned: boolean;
	prompt: CharacterPrompt;
	openings: string[];
}

export type CharacterCommand =
	| {
			type: "create";
			definition: {
				name: string;
				prompt: CharacterPrompt;
				openings: string[];
			};
	  }
	| { type: "rename"; characterId: number; expectedRevision: number; name: string }
	| {
			type: "replace-prompt";
			characterId: number;
			expectedRevision: number;
			prompt: CharacterPrompt;
	  }
	| {
			type: "replace-openings";
			characterId: number;
			expectedRevision: number;
			openings: string[];
	  }
	| {
			type: "set-pinned";
			characterId: number;
			expectedRevision: number;
			pinned: boolean;
	  };

export type CommandOutcome =
	| { status: "applied"; character: CharacterSnapshot }
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
	const { data, error } = await api.api.characters.commands.post(command);
	if (error) {
		const payload = error.value;
		if (payload.outcome === "conflict") {
			return { status: "conflict", currentCharacter: payload.currentCharacter };
		}
		if (payload.outcome === "not-found") {
			return { status: "not-found" };
		}
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: payload.reason };
		}
		return { status: "network" };
	}
	return { status: "applied", character: data.character };
}
