import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { imageAnchor, parseImageReferences } from "../../shared/image-reference";
import type { PromptWarning } from "../../shared/contract/conversation-schema";
import { boxImageGrantTable } from "../database/schema";
import type { ChatBoxes, LoadedBox } from "./registry";

// @approved
// Capture grants in the read transaction, before advance can suspend. Cast
// Portraits are display capabilities only, never permission to send pixels.
export const captureBoxPromptImages = (db: BunSQLiteDatabase, boxes: ChatBoxes, warnings: PromptWarning[]): ChatBoxes =>
	new Map([...boxes].map(([id, loaded]) => {
		if (loaded.client.kind !== "sandboxed") return [id, loaded] as const;
		const grants = new Set(db.select({ hash: boxImageGrantTable.hash }).from(boxImageGrantTable).where(eq(boxImageGrantTable.box_id, id)).all().map(({ hash }) => hash));
		const filter = (text: string): string => {
			for (const { hash, name, start, end } of parseImageReferences(text).reverse()) {
				if (grants.has(hash)) continue;
				warnings.push({ block: `${id} Box`, macro: name, reason: "ungranted-image" });
				text = text.slice(0, start) + imageAnchor(name) + text.slice(end);
			}
			return text;
		};
		const { box } = loaded;
		const advance = box.advance;
		const moves = box.moves;
		const guarded: LoadedBox = { ...loaded, box: {
			...box,
			...moves !== undefined && { moves: { ...moves, render: (move, author) => filter(moves.render(move, author)) } },
			...advance !== undefined && { advance: { ...advance, run: async (input, context) => {
				const result = await advance.run(input, context);
				return { ...result, items: result.items.map((item) => ({ ...item, text: filter(item.text) })) };
			} } },
		} };
		return [id, guarded] as const;
	}));
