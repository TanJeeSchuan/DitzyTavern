import { isActive } from "../database/is-active";
import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	characterLorebookAttachmentTable,
	characterTable,
	conversationTable,
	conversationLoreSettingsTable,
	conversationLorebookAttachmentTable,
	participantLorebookAttachmentTable,
	participantTable,
	lorebookTable,
} from "../database/schema";
import type { LoreAttachmentScope } from "../../shared/contract/lorebook";
import { findConversation, readActiveCast, readControlAssignment } from "../conversation";

export type LoreAttachmentOwner = "character" | "participant" | "conversation";

export interface LoreAttachment {
	readonly id: number;
	readonly owner: LoreAttachmentOwner;
	readonly ownerId: number;
	readonly bookId: number;
	readonly scope: LoreAttachmentScope;
	readonly enabled: boolean;
}

export interface LoreAttachmentEligibility extends LoreAttachment {
	readonly eligible: boolean;
	readonly reason: "eligible" | "disabled" | "not-in-cast" | "not-controlled";
}

export interface LoreSettings {
	readonly scanDepth: number;
	readonly allowance: number;
}

const connect = (database: Database) => drizzle(database);
type LoreDatabase = ReturnType<typeof connect>;

/** @approved Resolve scope before deduplication: an ineligible use cannot veto an eligible use. */
const readLorebookAttachmentEligibilityFrom = (
	db: LoreDatabase,
	conversationId: number,
): LoreAttachmentEligibility[] => {
	const control = readControlAssignment(db, conversationId);
	const controlled = new Set([control.humanParticipantId, control.modelParticipantId]
		.filter((participantId): participantId is number => participantId !== null));
	const cast = new Set(readActiveCast(db, conversationId).map((row) => row.id));
	const rows: LoreAttachmentEligibility[] = [];
	for (const row of db.select().from(conversationLorebookAttachmentTable)
		.where(eq(conversationLorebookAttachmentTable.conversation_id, conversationId)).all()) {
		rows.push({
			id: row.id,
			owner: "conversation",
			ownerId: conversationId,
			bookId: row.lorebook_id,
			scope: "chat",
			enabled: row.enabled,
			eligible: row.enabled,
			reason: row.enabled ? "eligible" : "disabled",
		});
	}
	for (const row of db.select().from(participantLorebookAttachmentTable)
		.innerJoin(participantTable, eq(participantTable.id, participantLorebookAttachmentTable.participant_id))
		.where(and(eq(participantTable.conversation_id, conversationId), isActive(participantTable))).all()) {
		const attachment = row.participant_lorebook_attachment;
		const eligible = attachment.enabled && (attachment.scope === "cast" ? cast.has(attachment.participant_id) : controlled.has(attachment.participant_id));
		rows.push({
			id: attachment.id,
			owner: "participant",
			ownerId: attachment.participant_id,
			bookId: attachment.lorebook_id,
			scope: attachment.scope,
			enabled: attachment.enabled,
			eligible,
			reason: !attachment.enabled ? "disabled" : eligible ? "eligible" : attachment.scope === "cast" ? "not-in-cast" : "not-controlled",
		});
	}
	return rows;
};

export const readLorebookAttachmentEligibility = (
	database: Database,
	conversationId: number,
): LoreAttachmentEligibility[] => readLorebookAttachmentEligibilityFrom(connect(database), conversationId);

export const readLorebookAttachmentState = (
	database: Database,
	conversationId: number,
) => {
	const db = connect(database);
	const conversation = findConversation(db, conversationId);
	if (conversation === undefined) return undefined;
	const settings = readLoreSettingsFrom(db, conversationId);
	return {
		conversationId,
		revision: conversation.revision,
		scanDepth: settings.scanDepth,
		allowance: settings.allowance,
		attachments: readLorebookAttachmentEligibilityFrom(db, conversationId),
	};
};

export const readLorebookAttachmentImpact = (
	database: Database,
	bookId: number,
) => {
	const db = connect(database);
	if (db.select({ id: lorebookTable.id }).from(lorebookTable).where(eq(lorebookTable.id, bookId)).get() === undefined) return undefined;
	return {
		bookId,
		attachments: [
			...db
				.select({
					id: characterLorebookAttachmentTable.id,
					ownerId: characterLorebookAttachmentTable.character_id,
					ownerName: characterTable.name,
					scope: characterLorebookAttachmentTable.scope,
					enabled: characterLorebookAttachmentTable.enabled,
				})
				.from(characterLorebookAttachmentTable)
				.innerJoin(characterTable, eq(characterTable.id, characterLorebookAttachmentTable.character_id))
				.where(and(eq(characterLorebookAttachmentTable.lorebook_id, bookId), isActive(characterTable)))
				.all()
				.map((row) => ({ ...row, owner: "character" as const })),
			...db
				.select({
					id: participantLorebookAttachmentTable.id,
					ownerId: participantLorebookAttachmentTable.participant_id,
					ownerName: participantTable.name,
					scope: participantLorebookAttachmentTable.scope,
					enabled: participantLorebookAttachmentTable.enabled,
				})
				.from(participantLorebookAttachmentTable)
				.innerJoin(participantTable, eq(participantTable.id, participantLorebookAttachmentTable.participant_id))
				.where(and(eq(participantLorebookAttachmentTable.lorebook_id, bookId), isActive(participantTable)))
				.all()
				.map((row) => ({ ...row, owner: "participant" as const })),
			...db
				.select({
					id: conversationLorebookAttachmentTable.id,
					ownerId: conversationLorebookAttachmentTable.conversation_id,
					ownerName: conversationTable.name,
					enabled: conversationLorebookAttachmentTable.enabled,
				})
				.from(conversationLorebookAttachmentTable)
				.innerJoin(conversationTable, eq(conversationTable.id, conversationLorebookAttachmentTable.conversation_id))
				.where(eq(conversationLorebookAttachmentTable.lorebook_id, bookId))
				.all()
				.map((row) => ({ ...row, scope: "chat" as const, owner: "conversation" as const })),
		],
	};
};

export const readCharacterLorebookAttachments = (database: Database, characterId: number) => {
	const db = connect(database);
	const character = db
		.select({ id: characterTable.id, revision: characterTable.revision })
		.from(characterTable)
		.where(and(eq(characterTable.id, characterId), isActive(characterTable)))
		.get();
	if (character === undefined) return undefined;
	return {
		owner: "character" as const,
		ownerId: characterId,
		revision: character.revision,
		attachments: db
			.select(ownerAttachmentSelection(characterLorebookAttachmentTable))
			.from(characterLorebookAttachmentTable)
			.where(eq(characterLorebookAttachmentTable.character_id, characterId))
			.all(),
	};
};

export const readParticipantLorebookAttachments = (database: Database, participantId: number) => {
	const db = connect(database);
	const participant = db
		.select({ id: participantTable.id, conversationId: participantTable.conversation_id })
		.from(participantTable)
		.where(and(eq(participantTable.id, participantId), isActive(participantTable)))
		.get();
	if (participant === undefined) return undefined;
	const conversation = findConversation(db, participant.conversationId);
	if (conversation === undefined) return undefined;
	return {
		owner: "participant" as const,
		ownerId: participantId,
		revision: conversation.revision,
		attachments: db
			.select(ownerAttachmentSelection(participantLorebookAttachmentTable))
			.from(participantLorebookAttachmentTable)
			.where(eq(participantLorebookAttachmentTable.participant_id, participantId))
			.all(),
	};
};

export const readLoreSettings = (database: Database, conversationId: number): LoreSettings =>
	readLoreSettingsFrom(connect(database), conversationId);

const readLoreSettingsFrom = (db: LoreDatabase, conversationId: number): LoreSettings => {
	const row = db.select().from(conversationLoreSettingsTable)
		.where(eq(conversationLoreSettingsTable.conversation_id, conversationId)).get();
	return { scanDepth: row?.scan_depth ?? 4, allowance: row?.allowance ?? 2048 };
};

const ownerAttachmentSelection = (table: typeof characterLorebookAttachmentTable | typeof participantLorebookAttachmentTable) => ({
	id: table.id,
	bookId: table.lorebook_id,
	scope: table.scope,
	enabled: table.enabled,
});
