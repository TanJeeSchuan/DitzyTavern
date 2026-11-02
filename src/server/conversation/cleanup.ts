import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { boxDescriptors, boxIdOf } from "../../shared/contract/box";
import { boxValueSchema, participantReferencesOf, type BoxValueScope } from "../box/row-references";
import { isHostChatKey } from "../box/setup";
import { parseStoredBoxJson } from "../box/stored-json";
import { collectReleasedCharacterTombstones } from "../character-library";
import {
	conversationDataTable, messageDataTable, messageTable, messageVariantDataTable, messageVariantTable, participantDataTable, participantTable,
} from "../database/schema";
import { messageReferencesParticipant, type ConversationDatabase } from "./internal";

// @approved
//  The Participants the Chat's Box values name through their schemas' Row
// References, the same references a fork rewrites. Null when a value cannot
// be read against its Box's schema (the Box is gone or the value is
// malformed): its references are unknown, so nothing may be collected.
const boxReferencedParticipants = (db: ConversationDatabase, conversationId: number): ReadonlySet<number> | null => {
	const messageIds = db.select({ id: messageTable.id }).from(messageTable).where(eq(messageTable.conversation_id, conversationId)).all().map(({ id }) => id);
	const variantIds = messageIds.length === 0 ? [] : db.select({ id: messageVariantTable.id }).from(messageVariantTable).where(inArray(messageVariantTable.message_id, messageIds)).all().map(({ id }) => id);
	const participantIds = db.select({ id: participantTable.id }).from(participantTable).where(eq(participantTable.conversation_id, conversationId)).all().map(({ id }) => id);
	const rows: { scope: BoxValueScope; namespace: string; key: string; value: string }[] = [
		...db.select().from(conversationDataTable).where(eq(conversationDataTable.conversation_id, conversationId)).all()
			.filter(({ key }) => !isHostChatKey(key) || key === "setup").map((row) => ({ ...row, scope: "chat" as const })),
		...(participantIds.length === 0 ? [] : db.select().from(participantDataTable).where(inArray(participantDataTable.participant_id, participantIds)).all().map((row) => ({ ...row, scope: "participant" as const }))),
		...(messageIds.length === 0 ? [] : db.select().from(messageDataTable).where(inArray(messageDataTable.message_id, messageIds)).all().map((row) => ({ ...row, scope: "message" as const }))),
		...(variantIds.length === 0 ? [] : db.select().from(messageVariantDataTable).where(inArray(messageVariantDataTable.message_variant_id, variantIds)).all().map((row) => ({ ...row, scope: "variant" as const }))),
	];
	const descriptors = boxDescriptors();
	const referenced = new Set<number>();
	for (const { scope, namespace, key, value } of rows) {
		const id = boxIdOf(namespace);
		if (id === undefined) continue;
		const descriptor = descriptors.get(id);
		if (descriptor === undefined) return null;
		const schema = boxValueSchema(descriptor, scope, key);
		if (schema === undefined) continue;
		try {
			for (const participantId of participantReferencesOf(schema, parseStoredBoxJson(value, schema, `${scope}/${key}`))) referenced.add(participantId);
		} catch {
			return null;
		}
	}
	return referenced;
};

export const collectReleasedTombstones = (
	db: ConversationDatabase,
	conversationId: number,
) => {
	const tombstones = db
		.select({
			id: participantTable.id,
			sourceCharacterId: participantTable.source_character_id,
		})
		.from(participantTable)
		.where(
			and(
				eq(participantTable.conversation_id, conversationId),
				isNotNull(participantTable.deleted_at),
			),
		)
		.all();
	if (tombstones.length === 0) return;
	const releasedSourceCharacterIds: number[] = [];

	const messages = db
		.select({
			authorParticipantId: messageTable.author_participant_id,
			contextHumanParticipantId: messageTable.context_human_participant_id,
			contextModelParticipantId: messageTable.context_model_participant_id,
		})
		.from(messageTable)
		.where(eq(messageTable.conversation_id, conversationId))
		.all();
	const released = tombstones.filter((tombstone) => !messages.some((message) => messageReferencesParticipant(message, tombstone.id)));
	if (released.length === 0) return;
	const boxReferenced = boxReferencedParticipants(db, conversationId);
	if (boxReferenced === null) return;

	for (const tombstone of released) {
		if (boxReferenced.has(tombstone.id)) continue;
		db.delete(participantTable)
			.where(eq(participantTable.id, tombstone.id))
			.run();
		if (tombstone.sourceCharacterId !== null) {
			releasedSourceCharacterIds.push(tombstone.sourceCharacterId);
		}
	}

	collectReleasedCharacterTombstones(db, releasedSourceCharacterIds);
};
