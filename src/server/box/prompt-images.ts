import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxImageGrantTable } from "../database/schema";
import type { BoxImageGrants } from "../prompt-compiler/images";
import type { ChatBoxes } from "./registry";

// @approved
// Capture grants in the read transaction, before advance can suspend. Cast
// Portraits are display capabilities only, never permission to send pixels.
export const captureBoxPromptImages = (db: BunSQLiteDatabase, boxes: ChatBoxes): BoxImageGrants =>
	new Map([...boxes].flatMap(([id, loaded]) => loaded.client.kind !== "sandboxed" ? [] : [[`box:${id}`, {
		label: loaded.descriptor.label,
		hashes: new Set(db.select({ hash: boxImageGrantTable.hash }).from(boxImageGrantTable).where(eq(boxImageGrantTable.box_id, id)).all().map(({ hash }) => hash)),
	}]]));
