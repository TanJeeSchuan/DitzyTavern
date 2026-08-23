import type { Database } from "bun:sqlite";
import { executeCharacterCommand } from "./execute";
import { withDatabase } from "../database/database";
import { connectCharacterLibraryDatabase } from "./internal";
import { listCharacters, readCharacterSnapshot } from "./snapshot";
import type {
	CharacterDeletionResult,
	CharacterLibraryCommand,
	CharacterLibraryModule,
	CharacterSnapshot,
} from "./types";

export {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from "./errors";
// Narrow garbage-collection hook for the Conversation domain: removes an
// already-tombstoned Character when its final provenance reference disappears.
export { collectReleasedCharacterTombstones } from "./cleanup";
export type {
	CharacterDeletionImpact,
	CharacterDeletionMode,
	CharacterDeletionResult,
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
	// Overloaded binding keeps the module contract precise: a confirmed
	// deletion returns the typed result, every other command returns the
	// authoritative Character.
	function execute(
		command: Extract<CharacterLibraryCommand, { type: "delete" }>,
	): CharacterDeletionResult;
	function execute(
		command: Exclude<CharacterLibraryCommand, { type: "delete" }>,
	): CharacterSnapshot;
	function execute(
		command: CharacterLibraryCommand,
	): CharacterSnapshot | CharacterDeletionResult {
		return executeCharacterCommand(database, command);
	}
	return {
		list: () => listCharacters(connectCharacterLibraryDatabase(database)),
		get: (characterId) =>
			readCharacterSnapshot(connectCharacterLibraryDatabase(database), characterId),
		execute,
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
