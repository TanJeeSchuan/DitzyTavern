// @approved
//  Shared database workflow for prepared Chat Import data. Source-specific
// importers retain parsing, artifact storage, duplicate handling, temporary
// state, and retry behavior; this seam owns only the all-or-nothing Character
// Library and Conversation changes.

import type { Database } from "bun:sqlite";
import { createCharacterLibraryModule } from "../character-library";
import { createConversationModule } from "../conversation";
import type {
	ConversationCreationInput,
	ConversationParticipantSeed,
	ConversationSnapshot,
} from "../conversation/types";

export interface ImportedConversationParticipantSeed
	extends ConversationParticipantSeed {
	createCharacter?: boolean | undefined;
}

export interface CreateImportedConversationInput
	extends Omit<ConversationCreationInput, "participants"> {
	participants: readonly ImportedConversationParticipantSeed[];
}

export function createImportedConversation(
	database: Database,
	input: CreateImportedConversationInput,
): ConversationSnapshot {
	const create = database.transaction(() => {
		const participants: ConversationParticipantSeed[] = input.participants.map(
			(participant) => {
				if (participant.createCharacter !== true) {
					return {
						definition: participant.definition,
						sourceCharacterId: participant.sourceCharacterId,
					};
				}

				const character = createCharacterLibraryModule(database).execute({
					type: "create",
					definition: participant.definition,
				});
				return {
					definition: participant.definition,
					sourceCharacterId: character.id,
				};
			},
		);
		const { participants: _participants, ...conversationInput } = input;
		return createConversationModule(database).create({
			...conversationInput,
			participants,
		});
	});

	return create.immediate();
}
