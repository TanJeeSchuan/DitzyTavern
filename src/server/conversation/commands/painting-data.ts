import { and, eq } from "drizzle-orm";
import type { PaintingCommandResult, PaintingDataCommand } from "../../../shared/contract/painting";
import { PAINTING_NAMESPACE } from "../../../shared/variant-data-codecs";
import { conversationDataTable as data } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import { readReferenceSets, updateReferenceSets } from "./update-reference-sets";

export function updatePaintingData(db: ConversationDatabase, conversationId: number, command: PaintingDataCommand): PaintingCommandResult {
	if (command.type === "set-aspect-ratio") {
		const value = JSON.stringify({ aspectRatio: command.aspectRatio });
		db.insert(data).values({ conversation_id: conversationId, namespace: PAINTING_NAMESPACE, key: "aspect-ratio", value })
			.onConflictDoUpdate({ target: [data.conversation_id, data.namespace, data.key], set: { value } }).run();
		return { outcome: "accepted" };
	}
	if (command.type === "remove-from-gallery") {
		db.delete(data).where(and(eq(data.conversation_id, conversationId), eq(data.namespace, PAINTING_NAMESPACE), eq(data.key, `gallery:${command.id}`))).run();
		return { outcome: "accepted" };
	}
	const conflict = updateReferenceSets(db, conversationId, command);
	return conflict === undefined
		? { outcome: "references-updated", selection: readReferenceSets(db, conversationId) }
		: { outcome: "reference-set-conflict", current: conflict };
}
