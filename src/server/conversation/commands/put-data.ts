import { chatDataTable, messageDataTable, messageVariantDataTable } from "../../database/schema";
import type { ConversationDataScope } from "../types";
import type { ConversationDatabase } from "../internal";
import {
	requireGenericDataNamespace,
	requireMessage,
	requireVariant,
} from "../internal";

export interface PutDataInput {
	conversationId: number;
	scope: ConversationDataScope;
	namespace: string;
	key: string;
	value: string;
}

export function putData(db: ConversationDatabase, input: PutDataInput) {
	// Import provenance is server-owned (ADR-0028): the generic data seam
	// cannot address the import-owned namespaces in any scope.
	requireGenericDataNamespace(input.namespace);
	switch (input.scope.type) {
		case "conversation":
			db.insert(chatDataTable)
				.values({
					chat_id: input.conversationId,
					namespace: input.namespace,
					key: input.key,
					value: input.value,
				})
				.onConflictDoUpdate({
					target: [chatDataTable.chat_id, chatDataTable.namespace, chatDataTable.key],
					set: { value: input.value },
				})
				.run();
			return;
		case "message":
			requireMessage(db, input.conversationId, input.scope.messageId);
			db.insert(messageDataTable)
				.values({
					message_id: input.scope.messageId,
					namespace: input.namespace,
					key: input.key,
					value: input.value,
				})
				.onConflictDoUpdate({
					target: [
						messageDataTable.message_id,
						messageDataTable.namespace,
						messageDataTable.key,
					],
					set: { value: input.value },
				})
				.run();
			return;
		case "variant":
			requireVariant(
				db,
				input.conversationId,
				input.scope.messageId,
				input.scope.variantId,
			);
			db.insert(messageVariantDataTable)
				.values({
					message_variant_id: input.scope.variantId,
					namespace: input.namespace,
					key: input.key,
					value: input.value,
				})
				.onConflictDoUpdate({
					target: [
						messageVariantDataTable.message_variant_id,
						messageVariantDataTable.namespace,
						messageVariantDataTable.key,
					],
					set: { value: input.value },
				})
				.run();
	}
}
