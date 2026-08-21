import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { chatTable } from "../database/schema";
import { createMessage } from "./commands/create-message";
import { createVariant } from "./commands/create-variant";
import { deleteData } from "./commands/delete-data";
import { deleteMessage } from "./commands/delete-message";
import { deleteVariant } from "./commands/delete-variant";
import { editVariant } from "./commands/edit-variant";
import { putData } from "./commands/put-data";
import { selectVariant } from "./commands/select-variant";
import {
	ConversationNotFoundError,
	StaleConversationRevisionError,
} from "./errors";
import { connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import type { ConversationCommand, ConversationSnapshot } from "./types";

export function executeConversationCommand(
	database: Database,
	command: ConversationCommand,
): ConversationSnapshot {
	const db = connectConversationDatabase(database);
	const execute = database.transaction(() => {
		const conversation = db
			.select({ revision: chatTable.revision })
			.from(chatTable)
			.where(eq(chatTable.id, command.conversationId))
			.get();
		if (conversation === undefined) {
			throw new ConversationNotFoundError(command.conversationId);
		}
		if (conversation.revision !== command.expectedRevision) {
			throw new StaleConversationRevisionError(
				command.expectedRevision,
				conversation.revision,
			);
		}

		const input = { conversationId: command.conversationId, ...command.action };
		switch (input.type) {
			case "create-message":
				createMessage(db, input);
				break;
			case "create-variant":
				createVariant(db, input);
				break;
			case "select-variant":
				selectVariant(db, input);
				break;
			case "edit-variant":
				editVariant(db, input);
				break;
			case "delete-variant":
				deleteVariant(db, input);
				break;
			case "delete-message":
				deleteMessage(db, input);
				break;
			case "put-data":
				putData(db, input);
				break;
			case "delete-data":
				deleteData(db, input);
				break;
		}

		const advanced = db
			.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1` })
			.where(
				and(
					eq(chatTable.id, command.conversationId),
					eq(chatTable.revision, command.expectedRevision),
				),
			)
			.returning({ revision: chatTable.revision })
			.get();
		if (advanced === undefined) {
			throw new StaleConversationRevisionError(
				command.expectedRevision,
				conversation.revision,
			);
		}

		const snapshot = readConversationSnapshot(db, command.conversationId);
		if (snapshot === undefined) {
			throw new ConversationNotFoundError(command.conversationId);
		}
		return snapshot;
	});

	return execute.immediate();
}
