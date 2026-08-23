import type { Database } from "bun:sqlite";
import { executeCharacterCommand } from "./execute";
import { withDatabase } from "../database/database";
import { connectCharacterLibraryDatabase } from "./internal";
import { listCharacters, readCharacterSnapshot } from "./snapshot";
import type { CharacterLibraryModule } from "./types";

export {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from "./errors";
export type {
	CharacterDefinition,
	CharacterLibraryCommand,
	CharacterLibraryModule,
	CharacterPrompt,
	CharacterSnapshot,
	CharacterSummary,
} from "./types";

export function createCharacterLibraryModule(
	database: Database,
): CharacterLibraryModule {
	return {
		list: () => listCharacters(connectCharacterLibraryDatabase(database)),
		get: (characterId) =>
			readCharacterSnapshot(connectCharacterLibraryDatabase(database), characterId),
		execute: (command) => executeCharacterCommand(database, command),
	};
}

// Runs one operation against a short-lived connection, mirroring how the
// other deep modules serve request-scoped callers. The default database is
// opened when no connection is supplied.
export function withCharacterLibrary<T>(
	database: Database | undefined,
	run: (library: CharacterLibraryModule) => T,
): T {
	return withDatabase(database, (connection) =>
		run(createCharacterLibraryModule(connection)),
	);
}
