// ==[HUMAN APPROVED]== Native New Chat workflow.
//
// Composes the Character Library and Conversation seams in one transaction:
// each initial seat resolves to a complete Definition — either the
// authoritative copy of a library Character (checked against its expected
// revision, copied server-side) or an ad-hoc Definition — and both seats are
// assigned before commit. A native Conversation therefore never exists in a
// partially configured state.

import type { Database } from "bun:sqlite";
import type { Static } from "@sinclair/typebox";
import { forkCharacter } from "../character-library";
import { createConversationModule } from "../conversation";
import type {
	ConversationSnapshot,
	ParticipantDefinition,
} from "../conversation/types";
import type {
	nativeConversationBody,
	newChatSeatSchema,
} from "../../shared/contract/native-conversation";

// ==[HUMAN APPROVED]== Seat shapes derive from the canonical native-conversation wire
// schema so the workflow can never drift from the transport contract.
export type NewChatSeat = Static<typeof newChatSeatSchema>;

export type CharacterForkSeat = Extract<NewChatSeat, { type: "character" }>;

export type AdHocSeat = Extract<NewChatSeat, { type: "adhoc" }>;

// ==[HUMAN APPROVED]== The input derives from the canonical native-conversation wire
// schema (ADR-0032); `createdAt` stays workflow-owned because the transport
// never submits it — the server defaults it to the creation time.
export type CreateNativeConversationInput = Static<typeof nativeConversationBody> & {
	createdAt?: string | undefined;
};

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
	return forkCharacter(database, seat.characterId, seat.expectedRevision);
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
