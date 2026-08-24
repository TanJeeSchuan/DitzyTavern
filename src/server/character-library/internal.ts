import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { characterTable } from "../database/schema";
import {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
} from "./errors";

export const connectCharacterLibraryDatabase = (database: Database) =>
	drizzle(database);
export type CharacterDatabase = ReturnType<typeof connectCharacterLibraryDatabase>;

// Names are normalized by removing leading and trailing whitespace while
// preserving case and Unicode exactly.
export const normalizeName = (name: string) => name.trim();

const requireName = (
	name: string,
	errorFactory: (message: string) => Error,
): string => {
	const normalized = normalizeName(name);
	if (normalized === "") {
		throw errorFactory("A Character name is required.");
	}
	return normalized;
};

// Openings are stored exactly as authored; only fully blank entries are
// rejected.
const requireOpenings = (
	openings: readonly string[],
	errorFactory: (message: string) => Error,
): readonly string[] => {
	openings.forEach((opening, index) => {
		if (opening.trim() === "") {
			throw errorFactory(
				`Opening at position ${index + 1} is blank; openings must contain text.`,
			);
		}
	});
	return openings;
};

// A Definition with name and openings validated for library storage.
export interface NormalizedDefinition {
	name: string;
	openings: readonly string[];
}

// Creation-time validation failures use the definition error type.
export function requireDefinition(
	name: string,
	openings: readonly string[],
): NormalizedDefinition {
	return {
		name: requireName(name, (message) => new InvalidCharacterDefinitionError(message)),
		openings: requireOpenings(
			openings,
			(message) => new InvalidCharacterDefinitionError(message),
		),
	};
}

// Command-time validation failures use the command error type.
export const requireCommandName = (name: string): string =>
	requireName(name, (message) => new InvalidCharacterCommandError(message));

export const requireCommandOpenings = (
	openings: readonly string[],
): readonly string[] =>
	requireOpenings(openings, (message) => new InvalidCharacterCommandError(message));

export interface CharacterRowState {
	id: number;
	name: string;
	revision: number;
	pinned: boolean;
}

// Reads the active lifecycle row for one Character. Tombstoned Characters
// are treated as not found by every public operation.
export const requireActiveCharacter = (
	db: CharacterDatabase,
	characterId: number,
): CharacterRowState => {
	const character = db
		.select({
			id: characterTable.id,
			name: characterTable.name,
			revision: characterTable.revision,
			pinned: characterTable.pinned,
		})
		.from(characterTable)
		.where(
			and(eq(characterTable.id, characterId), isNull(characterTable.deleted_at)),
		)
		.get();

	if (character === undefined) {
		throw new CharacterNotFoundError(characterId);
	}

	return character;
};
