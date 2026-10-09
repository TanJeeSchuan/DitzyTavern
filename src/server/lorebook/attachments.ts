import type { Database } from "bun:sqlite";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import type { LoreAttachmentCommand, LoreAttachmentScope } from "../../shared/contract/lorebook";
import { findConversation, readActiveCast, readControlAssignment } from "../conversation";
import { guardRevision, StaleRevisionError } from "../revision";

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

export class LoreAttachmentOwnerNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	constructor() {
		super("The Lore attachment owner was not found.");
		this.name = "LoreAttachmentOwnerNotFoundError";
	}
}

const connect = (database: Database) => drizzle(database);
type LoreDatabase = ReturnType<typeof connect>;

const requireScope = (scope: LoreAttachmentScope): Exclude<LoreAttachmentScope, "chat"> => {
	if (scope === "chat") throw new Error("Character and Participant Lore uses cannot have Chat scope.");
	return scope;
};

const participantScope = (scope: string): Exclude<LoreAttachmentScope, "chat"> => {
	if (scope === "controlled-participant" || scope === "cast") return scope;
	throw new Error(`Unknown Participant Lore scope: ${scope}`);
};

export const attachLorebookToCharacter = (
	database: Database,
	input: { characterId: number; bookId: number; scope: Exclude<LoreAttachmentScope, "chat">; enabled?: boolean },
) => {
	const db = connect(database);
	db.insert(characterLorebookAttachmentTable).values({
		character_id: input.characterId,
		lorebook_id: input.bookId,
		scope: requireScope(input.scope),
		enabled: input.enabled ?? true,
	}).onConflictDoUpdate({
		target: [characterLorebookAttachmentTable.character_id, characterLorebookAttachmentTable.lorebook_id, characterLorebookAttachmentTable.scope],
		set: { enabled: input.enabled ?? true },
	}).run();
};

export const detachLorebookFromCharacter = (database: Database, characterId: number, bookId: number, scope: Exclude<LoreAttachmentScope, "chat">) =>
	connect(database).delete(characterLorebookAttachmentTable).where(and(
		eq(characterLorebookAttachmentTable.character_id, characterId),
		eq(characterLorebookAttachmentTable.lorebook_id, bookId),
		eq(characterLorebookAttachmentTable.scope, requireScope(scope)),
	)).run();

/** @approved Resolve scope before deduplication: an ineligible use cannot veto an eligible use. */
export const readLorebookAttachmentEligibility = (
	database: Database,
	conversationId: number,
): LoreAttachmentEligibility[] => {
	const db = connect(database);
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
		.where(and(eq(participantTable.conversation_id, conversationId), isNull(participantTable.deleted_at))).all()) {
		const attachment = row.participant_lorebook_attachment;
		const eligible = attachment.enabled && (attachment.scope === "cast" ? cast.has(attachment.participant_id) : controlled.has(attachment.participant_id));
		rows.push({
			id: attachment.id,
			owner: "participant",
			ownerId: attachment.participant_id,
			bookId: attachment.lorebook_id,
			scope: participantScope(attachment.scope),
			enabled: attachment.enabled,
			eligible,
			reason: !attachment.enabled ? "disabled" : eligible ? "eligible" : attachment.scope === "cast" ? "not-in-cast" : "not-controlled",
		});
	}
	return rows;
};

export const readLorebookAttachmentState = (
	database: Database,
	conversationId: number,
) => {
	const db = connect(database);
	const conversation = findConversation(db, conversationId);
	if (conversation === undefined) return undefined;
	const settings = readLoreSettings(database, conversationId);
	return {
		conversationId,
		revision: conversation.revision,
		scanDepth: settings.scanDepth,
		allowance: settings.allowance,
		attachments: readLorebookAttachmentEligibility(database, conversationId),
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
				.where(eq(characterLorebookAttachmentTable.lorebook_id, bookId))
				.all()
				.map((row) => ({ ...row, scope: participantScope(row.scope), owner: "character" as const })),
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
				.where(eq(participantLorebookAttachmentTable.lorebook_id, bookId))
				.all()
				.map((row) => ({ ...row, scope: participantScope(row.scope), owner: "participant" as const })),
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
		.where(and(eq(characterTable.id, characterId), isNull(characterTable.deleted_at)))
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
			.all()
			.map(ownerAttachmentOf),
	};
};

// @approved
//  The Conversation a Participant Lore attachment command mutates:
// the Lorebook attachment wire command carries no conversation id, so the
// transport derives it from the Participant's own Chat reference. Undefined
// when the Participant is gone, which the route presents as not-found.
export const readParticipantConversationId = (database: Database, participantId: number): number | undefined =>
	connect(database).select({ conversationId: participantTable.conversation_id }).from(participantTable)
		.where(and(eq(participantTable.id, participantId), isNull(participantTable.deleted_at))).get()?.conversationId;

export const readParticipantLorebookAttachments = (database: Database, participantId: number) => {
	const db = connect(database);
	const participant = db
		.select({ id: participantTable.id, conversationId: participantTable.conversation_id })
		.from(participantTable)
		.where(and(eq(participantTable.id, participantId), isNull(participantTable.deleted_at)))
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
			.all()
			.map(ownerAttachmentOf),
	};
};

export const readLoreSettings = (database: Database, conversationId: number): LoreSettings => {
	const db = connect(database);
	const row = db.select().from(conversationLoreSettingsTable)
		.where(eq(conversationLoreSettingsTable.conversation_id, conversationId)).get();
	return { scanDepth: row?.scan_depth ?? 4, allowance: row?.allowance ?? 2048 };
};

const advanceCharacterRevision = (database: Database, db: LoreDatabase, characterId: number, expectedRevision: number) => {
	const advanced = db.update(characterTable)
		.set({ revision: sql`${characterTable.revision} + 1` })
		.where(and(eq(characterTable.id, characterId), eq(characterTable.revision, expectedRevision)))
		.returning({ revision: characterTable.revision })
		.get();
	if (advanced === undefined) {
		const current = readCharacterLorebookAttachments(database, characterId);
		if (current === undefined) throw new LoreAttachmentOwnerNotFoundError();
		throw new StaleRevisionError("lore-attachment", expectedRevision, current.revision, current);
	}
};

// @approved
//  The two Character-owned Lore attachment commands stay in the Lorebook
// module: the Character Library owns their revision, and the guarded advance
// below is its attachment-command application. The five Conversation-owned
// commands (attach-chat, detach-chat, attach-participant, detach-participant,
// save-settings) dispatch through executeConversationCommand in the Lorebook
// attachment route and inherit the Conversation seam's revision guard,
// post-write summary, and conflict shape instead.
export const executeLorebookAttachmentCommand = (
	database: Database,
	command: Extract<LoreAttachmentCommand, { type: "attach-character" | "detach-character" }>,
): void => {
	const db = connect(database);
	database.transaction(() => {
		const owner = db
			.select({ revision: characterTable.revision })
			.from(characterTable)
			.where(and(eq(characterTable.id, command.characterId), isNull(characterTable.deleted_at)))
			.get();
		if (owner === undefined) throw new LoreAttachmentOwnerNotFoundError();
		guardRevision("lore-attachment", command.expectedRevision, owner, () => {
			const current = readCharacterLorebookAttachments(database, command.characterId);
			if (current === undefined) throw new LoreAttachmentOwnerNotFoundError();
			return current;
		});
		if (command.type === "attach-character") attachLorebookToCharacter(database, command);
		else detachLorebookFromCharacter(database, command.characterId, command.bookId, command.scope);
		advanceCharacterRevision(database, db, command.characterId, command.expectedRevision);
	}).immediate();
};

const ownerAttachmentSelection = (table: typeof characterLorebookAttachmentTable | typeof participantLorebookAttachmentTable) => ({
	id: table.id,
	bookId: table.lorebook_id,
	scope: table.scope,
	enabled: table.enabled,
});

const ownerAttachmentOf = (row: { id: number; bookId: number; scope: string; enabled: boolean }) => ({
	...row,
	scope: participantScope(row.scope),
});
