import { Value } from "@sinclair/typebox/value";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxIds, boxReference, type BoxId, type BoxSetups, type PromptBoxReference } from "../../shared/contract/box";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import { conversationDataTable } from "../database/schema";
import { authorNoteBox } from "./author-note";
import type { BlockItem, Box } from "./contract";

export const boxes = {
	"author-note": authorNoteBox,
} satisfies { [Id in BoxId]: Box<BoxSetups[Id]> };

/** @approved What each Box with an enabled preset block contributes to one Generation. */
export type BoxItems = Partial<Record<PromptBoxReference, readonly BlockItem[]>>;

const SETUP_KEY = "setup";

export const boxSetupEntry = <Id extends BoxId>(id: Id, setup: BoxSetups[Id]) =>
	({ namespace: boxReference(id), key: SETUP_KEY, value: JSON.stringify(setup) });

const decodeSetup = <Id extends BoxId>(id: Id, stored: string | undefined): BoxSetups[Id] => {
	const { schema, initial } = boxes[id].setup;
	if (stored === undefined) return initial;
	const setup: unknown = JSON.parse(stored);
	if (!Value.Check(schema, setup)) throw new Error(`The stored ${id} Box setup does not match its schema. Clear the ${boxReference(id)} namespace.`);
	// @approved
	//  SAFETY: Value.Check just verified the value against this Box's setup schema.
	return setup as BoxSetups[Id];
};

export const readBoxSetups = (db: BunSQLiteDatabase, conversationId: number): BoxSetups => {
	const stored = new Map(db
		.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, SETUP_KEY)))
		.all()
		.map((row) => [row.namespace, row.value]));
	return { "author-note": decodeSetup("author-note", stored.get(boxReference("author-note"))) };
};

// @approved
//  Capture and advance for every Box whose preset block is enabled. Boxes
// without an enabled block never run.
export const advanceBoxes = (slots: readonly PromptPresetSlot[], setups: BoxSetups): BoxItems =>
	Object.fromEntries(boxIds
		.filter((id) => slots.some((slot) => slot.enabled && slot.reference === boxReference(id)))
		.map((id) => [boxReference(id), boxes[id].advance.run({ setup: setups[id] }).items]));
