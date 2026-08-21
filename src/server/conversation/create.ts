import type { Database } from "bun:sqlite";
import { inArray } from "drizzle-orm";
import {
	characterTable,
	chatCharacterTable,
	chatDataTable,
	chatTable,
	messageDataTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
} from "../database/schema";
import { InvalidConversationCreationError } from "./errors";
import { connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import type {
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationDataEntry,
	ConversationSnapshot,
} from "./types";

const validateMessage = (message: ConversationCreationMessage, position: number) => {
	if (message.variants.length === 0) {
		throw new InvalidConversationCreationError(
			`Message at position ${position} has no Variants.`,
		);
	}
	const selectedCount = message.variants.filter(
		(variant) => variant.selected,
	).length;
	if (selectedCount !== 1) {
		throw new InvalidConversationCreationError(
			`Message at position ${position} must have exactly one selected Variant, but ${selectedCount} are selected.`,
		);
	}
};

const chronological = (a: string, b: string) =>
	Date.parse(a) - Date.parse(b);

const deriveChatTimes = (messages: readonly ConversationCreationMessage[]) => {
	const messageTimestamps = messages.map((message) => message.timestamp);
	const variantTimestamps = messages.flatMap((message) =>
		message.variants.map((variant) => variant.timestamp),
	);
	const now = new Date().toISOString();
	return {
		creationTime:
			messageTimestamps.length > 0
				? [...messageTimestamps].sort(chronological)[0]
				: now,
		lastMessageTime:
			variantTimestamps.length > 0
				? [...variantTimestamps].sort(chronological)[
						variantTimestamps.length - 1
					]
				: now,
	};
};

const insertScopedData = <Owner extends object>(
	data: readonly ConversationDataEntry[] | undefined,
	toRow: (entry: ConversationDataEntry) => Owner,
	insert: (rows: Owner[]) => void,
) => {
	if (data === undefined || data.length === 0) return;
	insert(data.map(toRow));
};

export function createConversation(
	database: Database,
	input: ConversationCreationInput,
): ConversationSnapshot {
	const db = connectConversationDatabase(database);
	const create = database.transaction(() => {
		const characterIds = [...new Set(input.characterIds ?? [])];
		if (characterIds.length > 0) {
			const known = db
				.select({ id: characterTable.id })
				.from(characterTable)
				.where(inArray(characterTable.id, characterIds))
				.all()
				.map((row) => row.id);
			const missing = characterIds.filter((id) => !known.includes(id));
			if (missing.length > 0) {
				throw new InvalidConversationCreationError(
					`Characters do not exist: ${missing.join(", ")}.`,
				);
			}
		}

		const messages = input.messages ?? [];
		messages.forEach((message, index) => validateMessage(message, index + 1));

		const { creationTime, lastMessageTime } = deriveChatTimes(messages);
		const conversation = db
			.insert(chatTable)
			.values({
				name: input.name,
				creation_time: creationTime,
				last_message_time: lastMessageTime,
			})
			.returning({ id: chatTable.id })
			.get();

		if (characterIds.length > 0) {
			db.insert(chatCharacterTable)
				.values(
					characterIds.map((characterId) => ({
						chat_id: conversation.id,
						character_id: characterId,
					})),
				)
				.run();
		}

		insertScopedData(
			input.data,
			(entry) => ({ ...entry, chat_id: conversation.id }),
			(rows) => db.insert(chatDataTable).values(rows).run(),
		);

		for (const [messageIndex, message] of messages.entries()) {
			const insertedMessage = db
				.insert(messageTable)
				.values({
					chat_id: conversation.id,
					position: messageIndex + 1,
					timestamp: message.timestamp,
				})
				.returning({ id: messageTable.id })
				.get();

			insertScopedData(
				message.data,
				(entry) => ({ ...entry, message_id: insertedMessage.id }),
				(rows) => db.insert(messageDataTable).values(rows).run(),
			);

			const insertedVariants = db
				.insert(messageVariantTable)
				.values(
					message.variants.map((variant, variantIndex) => ({
						message_id: insertedMessage.id,
						position: variantIndex + 1,
						content: variant.content,
						timestamp: variant.timestamp,
						selected: variant.selected,
					})),
				)
				.returning({ id: messageVariantTable.id })
				.all();

			const variantData = message.variants.flatMap((variant, variantIndex) => {
				const variantId = insertedVariants[variantIndex]?.id;
				if (variantId === undefined || variant.data === undefined) return [];
				return variant.data.map((entry) => ({
					...entry,
					message_variant_id: variantId,
				}));
			});
			if (variantData.length > 0) {
				db.insert(messageVariantDataTable).values(variantData).run();
			}
		}

		const snapshot = readConversationSnapshot(db, conversation.id);
		if (snapshot === undefined) {
			throw new InvalidConversationCreationError(
				"Created Conversation could not be read back.",
			);
		}
		return snapshot;
	});

	return create.immediate();
}
