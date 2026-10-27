import { eq } from "drizzle-orm";
import { conversationTable } from "../../database/schema";
import { InvalidImageError, readImage } from "../../image";
import type { ConversationDatabase } from "../internal";

export function setBackground(db: ConversationDatabase, input: { conversationId: number; hash: string | null }) {
	if (input.hash !== null && readImage(db, input.hash) === undefined) throw new InvalidImageError("The background image is missing.");
	db.update(conversationTable).set({ background_hash: input.hash }).where(eq(conversationTable.id, input.conversationId)).run();
}
