// ==[HUMAN APPROVED]== Native New Chat workflow.
//
// Composes the Character Library and Conversation seams in one transaction:
// each initial seat resolves to a complete Definition — either the
// authoritative copy of a library Character (checked against its expected
// revision, copied server-side) or an ad-hoc Definition — and both seats are
// assigned before commit. A native Conversation therefore never exists in a
// partially configured state.

import type { Database } from "bun:sqlite";
import {
	CharacterNotFoundError,
	StaleCharacterRevisionError,
	withCharacterLibrary,
} from "../character-library";
import { createConversationModule } from "../conversation";
import type {
	ConversationSnapshot,
	ParticipantDefinition,
} from "../conversation/types";

export interface CharacterForkSeat {
	type: "character";
	characterId: number;
	expectedRevision: number;
}

export interface AdHocSeat {
	type: "adhoc";
	definition: ParticipantDefinition;
}

export type NewChatSeat = CharacterForkSeat | AdHocSeat;

export interface CreateNativeConversationInput {
	name: string;
	humanSeat: NewChatSeat;
	modelSeat: NewChatSeat;
	createdAt?: string | undefined;
}

interface ResolvedSeat {
	definition: ParticipantDefinition;
	sourceCharacterId?: number | undefined;
}

const resolveSeat = (
	database: Database,
	seat: NewChatSeat,
): ResolvedSeat => {
	if (seat.type === "adhoc") {
		return { definition: seat.definition };
	}

	const character = withCharacterLibrary(database, (library) =>
		library.get(seat.characterId),
	);
	if (character === undefined) {
		throw new CharacterNotFoundError(seat.characterId);
	}
	if (character.revision !== seat.expectedRevision) {
		throw new StaleCharacterRevisionError(
			character.id,
			seat.expectedRevision,
			character.revision,
			character,
		);
	}

	return {
		definition: {
			name: character.name,
			prompt: character.prompt,
			openings: character.openings,
		},
		sourceCharacterId: character.id,
	};
};

export function createNativeConversation(
	database: Database,
	input: CreateNativeConversationInput,
): ConversationSnapshot {
	const create = database.transaction(() => {
		const human = resolveSeat(database, input.humanSeat);
		const model = resolveSeat(database, input.modelSeat);

		return createConversationModule(database).create({
			name: input.name,
			participants: [human, model],
			control: { human: 0, model: 1 },
			createdAt: input.createdAt,
		});
	});

	return create.immediate();
}
