import type { Database } from "bun:sqlite";
import { executeCharacterCommand } from "./execute";

import { connectCharacterLibraryDatabase } from "./internal";
import { listCharacters, readCharacterSnapshot } from "./snapshot";
import type {
	CharacterDeletionResult,
	CharacterCommand,
	CharacterDeletionCommand,
	CharacterMutationCommand,
	CharacterLibraryModule,
	CharacterSnapshot,
} from "./types";

export {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
} from "./errors";
// @approved
//  Narrow garbage-collection hook for the Conversation domain: removes an
// already-tombstoned Character when its final provenance reference disappears.
export { collectReleasedCharacterTombstones } from "./cleanup";
// @approved
//  Storage codec for the Prompt channels and Portrait columns shared by
//  Character Definitions and Conversation Participants.
export { fromPortraitColumns, toPromptChannelRow, toPromptChannels } from "./prompt-rows";
// @approved
//  Canonical copy-into-Conversation seam: the Library validates the
// revision the caller read and projects the Definition with its provenance.
export { forkCharacter, type CharacterFork } from "./fork";
export type {
	CharacterDeletionImpact,
	CharacterDeletionMode,
	CharacterDeletionResult,
	CharacterDefinition,
	CharacterCommand,
	CharacterDeletionCommand,
	CharacterMutationCommand,
	CharacterLibraryModule,
	CharacterSnapshot,
	CharacterLibrarySummary,
} from "./types";

export function createCharacterLibraryModule(
	database: Database,
): CharacterLibraryModule {
	// @approved
	//  Overloaded binding keeps the module contract precise: a confirmed
	// deletion returns the typed result, every other command returns the
	// authoritative Character.
	function execute(
		command: CharacterDeletionCommand,
	): CharacterDeletionResult;
	function execute(
		command: CharacterMutationCommand,
	): CharacterSnapshot;
	function execute(
		command: CharacterCommand,
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
