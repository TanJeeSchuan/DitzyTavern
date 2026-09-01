import type { CharacterSnapshot } from "./types";

export class CharacterNotFoundError extends Error {
	readonly characterId: number;

	constructor(characterId: number) {
		super(`Character ${characterId} was not found.`);
		this.name = "CharacterNotFoundError";
		this.characterId = characterId;
	}
}

// ==[HUMAN APPROVED]== Typed revision conflict. Carries the authoritative current Character so
// callers can recover without overwriting their local draft.
export class StaleCharacterRevisionError extends Error {
	readonly characterId: number;
	readonly expectedRevision: number;
	readonly actualRevision: number;
	readonly currentCharacter: CharacterSnapshot;

	constructor(
		characterId: number,
		expectedRevision: number,
		actualRevision: number,
		currentCharacter: CharacterSnapshot,
	) {
		super(
			`Expected Character ${characterId} revision ${expectedRevision}, but the current revision is ${actualRevision}.`,
		);
		this.name = "StaleCharacterRevisionError";
		this.characterId = characterId;
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
		this.currentCharacter = currentCharacter;
	}
}

export class InvalidCharacterDefinitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCharacterDefinitionError";
	}
}

export class InvalidCharacterCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCharacterCommandError";
	}
}
