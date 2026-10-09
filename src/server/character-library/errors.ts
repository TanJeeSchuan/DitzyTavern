export class CharacterNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	readonly characterId: number;

	constructor(characterId: number) {
		super(`Character ${characterId} was not found.`);
		this.name = "CharacterNotFoundError";
		this.characterId = characterId;
	}
}

export class InvalidCharacterDefinitionError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "InvalidCharacterDefinitionError";
	}
}

export class InvalidCharacterCommandError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "InvalidCharacterCommandError";
	}
}
