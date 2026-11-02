import { and, eq, inArray, isNotNull, like, notInArray } from "drizzle-orm";
import { boxDescriptors, boxIdOf } from "../../shared/contract/box";
import { boxValueSchema, holdsRowReferences, participantReferencesOf, type BoxValueScope } from "../box/row-references";
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
// Only Box-owned keys a Box schema covers are read: Generation traces, import
// archives and other host data run to tens of megabytes per Chat and never
// hold a Row Reference a fork rewrites.
const boxReferencedParticipants = (db: ConversationDatabase, conversationId: number): ReadonlySet<number> | null => {
	const messageIds = db.select({ id: messageTable.id }).from(messageTable).where(eq(messageTable.conversation_id, conversationId)).all().map(({ id }) => id);
	const variantIds = messageIds.length === 0 ? [] : db.select({ id: messageVariantTable.id }).from(messageVariantTable).where(inArray(messageVariantTable.message_id, messageIds)).all().map(({ id }) => id);
	const participantIds = db.select({ id: participantTable.id }).from(participantTable).where(eq(participantTable.conversation_id, conversationId)).all().map(({ id }) => id);
	const boxOwned = like(conversationDataTable.namespace, "box:%");
	const chatRows = db.select().from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), boxOwned, notInArray(conversationDataTable.key, ["enabled", "instance"]))).all();
	const participantRows = participantIds.length === 0 ? [] : db.select().from(participantDataTable)
		.where(and(inArray(participantDataTable.participant_id, participantIds), like(participantDataTable.namespace, "box:%"))).all();
	const messageRows = messageIds.length === 0 ? [] : db.select().from(messageDataTable)
		.where(and(inArray(messageDataTable.message_id, messageIds), like(messageDataTable.namespace, "box:%"), eq(messageDataTable.key, "moves"))).all();
	const variantRows = variantIds.length === 0 ? [] : db.select().from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, variantIds), like(messageVariantDataTable.namespace, "box:%"), like(messageVariantDataTable.key, "record:%"))).all();
	const rows: { scope: BoxValueScope; namespace: string; key: string; value: string }[] = [
		...chatRows.map((row) => ({ ...row, scope: "chat" as const })),
		...participantRows.map((row) => ({ ...row, scope: "participant" as const })),
		...messageRows.map((row) => ({ ...row, scope: "message" as const })),
		...variantRows.map((row) => ({ ...row, scope: "variant" as const })),
	];
	const descriptors = boxDescriptors();
	const referenced = new Set<number>();
	for (const { scope, namespace, key, value } of rows) {
		const id = boxIdOf(namespace);
		if (id === undefined) continue;
		const descriptor = descriptors.get(id);
		if (descriptor === undefined) return null;
		const schema = boxValueSchema(descriptor, scope, key);
		if (schema === undefined || !holdsRowReferences(schema)) continue;
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
