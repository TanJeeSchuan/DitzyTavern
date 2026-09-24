import { and, eq } from "drizzle-orm";
import { conversationDataTable, messageDataTable, messageVariantDataTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import {
	requireGenericDataNamespace,
	requireMessage,
	requireVariant,
} from "../internal";
import type { ConversationDataScope } from "../types";

export interface DeleteDataInput {
	conversationId: number;
	scope: ConversationDataScope;
	namespace: string;
	key: string;
}

export function deleteData(db: ConversationDatabase, input: DeleteDataInput) {
	requireGenericDataNamespace(input.namespace);
	switch (input.scope.type) {
		case "conversation":
			db.delete(conversationDataTable)
				.where(
					and(
						eq(conversationDataTable.conversation_id, input.conversationId),
						eq(conversationDataTable.namespace, input.namespace),
						eq(conversationDataTable.key, input.key),
					),
				)
				.run();
			return;
		case "message":
			requireMessage(db, input.conversationId, input.scope.messageId);
			db.delete(messageDataTable)
				.where(
					and(
						eq(messageDataTable.message_id, input.scope.messageId),
						eq(messageDataTable.namespace, input.namespace),
						eq(messageDataTable.key, input.key),
					),
				)
				.run();
			return;
		case "variant":
			requireVariant(
				db,
				input.conversationId,
				input.scope.messageId,
				input.scope.variantId,
			);
			db.delete(messageVariantDataTable)
				.where(
					and(
						eq(
							messageVariantDataTable.message_variant_id,
							input.scope.variantId,
						),
						eq(messageVariantDataTable.namespace, input.namespace),
						eq(messageVariantDataTable.key, input.key),
					),
				)
				.run();
	}
}
