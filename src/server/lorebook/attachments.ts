import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	characterLorebookAttachmentTable,
	characterTable,
	conversationTable,
	conversationControlTable,
	conversationLoreSettingsTable,
	conversationLorebookAttachmentTable,
	participantLorebookAttachmentTable,
	participantTable,
	lorebookTable,
} from "../database/schema";
import type { LoreAttachmentScope } from "../../shared/contract/lorebook";

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

type LoreDatabase = ReturnType<typeof drizzle>;
const connect = (database: Database): LoreDatabase => drizzle(database);

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

export const attachLorebookToParticipant = (
	database: Database,
	input: { participantId: number; bookId: number; scope: Exclude<LoreAttachmentScope, "chat">; enabled?: boolean },
) => {
	const db = connect(database);
	db.insert(participantLorebookAttachmentTable).values({
		participant_id: input.participantId,
		lorebook_id: input.bookId,
		scope: requireScope(input.scope),
		enabled: input.enabled ?? true,
	}).onConflictDoUpdate({
		target: [participantLorebookAttachmentTable.participant_id, participantLorebookAttachmentTable.lorebook_id, participantLorebookAttachmentTable.scope],
		set: { enabled: input.enabled ?? true },
	}).run();
};

export const attachLorebookToConversation = (
	database: Database,
	input: { conversationId: number; bookId: number; enabled?: boolean },
) => {
	const db = connect(database);
	db.insert(conversationLorebookAttachmentTable).values({
		conversation_id: input.conversationId,
		lorebook_id: input.bookId,
		enabled: input.enabled ?? true,
	}).onConflictDoUpdate({
		target: [conversationLorebookAttachmentTable.conversation_id, conversationLorebookAttachmentTable.lorebook_id],
		set: { enabled: input.enabled ?? true },
	}).run();
};

export const detachLorebookFromCharacter = (database: Database, characterId: number, bookId: number) =>
	connect(database).delete(characterLorebookAttachmentTable).where(and(
		eq(characterLorebookAttachmentTable.character_id, characterId),
		eq(characterLorebookAttachmentTable.lorebook_id, bookId),
	)).run();

export const detachLorebookFromParticipant = (database: Database, participantId: number, bookId: number) =>
	connect(database).delete(participantLorebookAttachmentTable).where(and(
		eq(participantLorebookAttachmentTable.participant_id, participantId),
		eq(participantLorebookAttachmentTable.lorebook_id, bookId),
	)).run();

export const detachLorebookFromConversation = (database: Database, conversationId: number, bookId: number) =>
	connect(database).delete(conversationLorebookAttachmentTable).where(and(
		eq(conversationLorebookAttachmentTable.conversation_id, conversationId),
		eq(conversationLorebookAttachmentTable.lorebook_id, bookId),
	)).run();

/** ==[HUMAN APPROVED]== Resolve scope before deduplication: an ineligible use cannot veto an eligible use. */
export const readLorebookAttachmentEligibility = (
	database: Database,
	conversationId: number,
): LoreAttachmentEligibility[] => {
	const db = connect(database);
	const controls = db.select({ participantId: conversationControlTable.participant_id })
		.from(conversationControlTable).where(eq(conversationControlTable.conversation_id, conversationId)).all();
	const controlled = new Set(controls.map((row) => row.participantId));
	const cast = new Set(db.select({ id: participantTable.id }).from(participantTable)
		.where(and(eq(participantTable.conversation_id, conversationId), isNull(participantTable.deleted_at))).all().map((row) => row.id));
	const rows: LoreAttachmentEligibility[] = [];
	for (const row of db.select().from(conversationLorebookAttachmentTable)
		.where(eq(conversationLorebookAttachmentTable.conversation_id, conversationId)).all()) {
		rows.push({ id: row.id, owner: "conversation", ownerId: conversationId, bookId: row.lorebook_id, scope: "chat", enabled: row.enabled, eligible: row.enabled, reason: row.enabled ? "eligible" : "disabled" });
	}
	for (const row of db.select().from(participantLorebookAttachmentTable)
		.innerJoin(participantTable, eq(participantTable.id, participantLorebookAttachmentTable.participant_id))
		.where(and(eq(participantTable.conversation_id, conversationId), isNull(participantTable.deleted_at))).all()) {
		const attachment = row.participant_lorebook_attachment;
		const eligible = attachment.enabled && (attachment.scope === "cast" ? cast.has(attachment.participant_id) : controlled.has(attachment.participant_id));
		rows.push({ id: attachment.id, owner: "participant", ownerId: attachment.participant_id, bookId: attachment.lorebook_id, scope: participantScope(attachment.scope), enabled: attachment.enabled, eligible, reason: !attachment.enabled ? "disabled" : eligible ? "eligible" : attachment.scope === "cast" ? "not-in-cast" : "not-controlled" });
	}
	return rows;
};

export const readLorebookAttachmentState = (
	database: Database,
	conversationId: number,
) => {
	const db = connect(database);
	const conversation = db.select({ id: conversationTable.id }).from(conversationTable)
		.where(eq(conversationTable.id, conversationId)).get();
	if (conversation === undefined) return undefined;
	const settings = readLoreSettings(database, conversationId);
	return {
		conversationId,
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
			...db.select({ id: characterLorebookAttachmentTable.id, ownerId: characterLorebookAttachmentTable.character_id, scope: characterLorebookAttachmentTable.scope, enabled: characterLorebookAttachmentTable.enabled })
				.from(characterLorebookAttachmentTable).where(eq(characterLorebookAttachmentTable.lorebook_id, bookId)).all()
				.map((row) => ({ ...row, scope: participantScope(row.scope), owner: "character" as const })),
			...db.select({ id: participantLorebookAttachmentTable.id, ownerId: participantLorebookAttachmentTable.participant_id, scope: participantLorebookAttachmentTable.scope, enabled: participantLorebookAttachmentTable.enabled })
				.from(participantLorebookAttachmentTable).where(eq(participantLorebookAttachmentTable.lorebook_id, bookId)).all()
				.map((row) => ({ ...row, scope: participantScope(row.scope), owner: "participant" as const })),
			...db.select({ id: conversationLorebookAttachmentTable.id, ownerId: conversationLorebookAttachmentTable.conversation_id, enabled: conversationLorebookAttachmentTable.enabled })
				.from(conversationLorebookAttachmentTable).where(eq(conversationLorebookAttachmentTable.lorebook_id, bookId)).all()
				.map((row) => ({ ...row, scope: "chat" as const, owner: "conversation" as const })),
		],
	};
};

export const readCharacterLorebookAttachments = (database: Database, characterId: number) => {
	const db = connect(database);
	if (db.select({ id: characterTable.id }).from(characterTable).where(and(eq(characterTable.id, characterId), isNull(characterTable.deleted_at))).get() === undefined) return undefined;
	return {
		owner: "character" as const,
		ownerId: characterId,
		attachments: db.select({ id: characterLorebookAttachmentTable.id, bookId: characterLorebookAttachmentTable.lorebook_id, scope: characterLorebookAttachmentTable.scope, enabled: characterLorebookAttachmentTable.enabled })
			.from(characterLorebookAttachmentTable).where(eq(characterLorebookAttachmentTable.character_id, characterId)).all().map((row) => ({ ...row, scope: participantScope(row.scope) })),
	};
};

export const readParticipantLorebookAttachments = (database: Database, participantId: number) => {
	const db = connect(database);
	if (db.select({ id: participantTable.id }).from(participantTable).where(and(eq(participantTable.id, participantId), isNull(participantTable.deleted_at))).get() === undefined) return undefined;
	return {
		owner: "participant" as const,
		ownerId: participantId,
		attachments: db.select({ id: participantLorebookAttachmentTable.id, bookId: participantLorebookAttachmentTable.lorebook_id, scope: participantLorebookAttachmentTable.scope, enabled: participantLorebookAttachmentTable.enabled })
			.from(participantLorebookAttachmentTable).where(eq(participantLorebookAttachmentTable.participant_id, participantId)).all().map((row) => ({ ...row, scope: participantScope(row.scope) })),
	};
};

export const readLoreSettings = (database: Database, conversationId: number): LoreSettings => {
	const db = connect(database);
	const row = db.select().from(conversationLoreSettingsTable)
		.where(eq(conversationLoreSettingsTable.conversation_id, conversationId)).get();
	return { scanDepth: row?.scan_depth ?? 4, allowance: row?.allowance ?? 2048 };
};

export const saveLoreSettings = (database: Database, conversationId: number, settings: LoreSettings): LoreSettings => {
	if (!Number.isInteger(settings.scanDepth) || settings.scanDepth < 0) throw new Error("Lore scan depth must be a non-negative whole number.");
	if (!Number.isInteger(settings.allowance) || settings.allowance < 0) throw new Error("Lore allowance must be a non-negative whole number.");
	const db = connect(database);
	db.insert(conversationLoreSettingsTable).values({ conversation_id: conversationId, scan_depth: settings.scanDepth, allowance: settings.allowance })
		.onConflictDoUpdate({ target: conversationLoreSettingsTable.conversation_id, set: { scan_depth: settings.scanDepth, allowance: settings.allowance } }).run();
	return settings;
};
