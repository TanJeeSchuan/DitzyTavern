import { raceBox } from "./race";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxReference, type BoxSetups } from "../../shared/contract/box";
import { conversationDataTable } from "../database/schema";
import { authorNoteBox } from "./author-note";
import { worldClockBox } from "./world-clock";

const SETUP_KEY = "setup";

export const boxSetupEntry = <Id extends keyof BoxSetups>(id: Id, setup: BoxSetups[Id]) =>
	({ namespace: boxReference(id), key: SETUP_KEY, value: JSON.stringify(setup) });

const decodeSetup = <Setup>(id: keyof BoxSetups, { schema, initial }: { readonly schema: TSchema; readonly initial: Setup }, stored: string | undefined): Setup => {
	if (stored === undefined) return initial;
	const setup: unknown = JSON.parse(stored);
	if (!Value.Check(schema, setup)) throw new Error(`The stored ${id} Box setup does not match its schema. Clear the ${boxReference(id)} namespace.`);
	// @approved
	//  SAFETY: Value.Check just verified the value against this Box's setup schema.
	return setup as Setup;
};

export const readBoxSetups = (db: BunSQLiteDatabase, conversationId: number): BoxSetups => {
	const stored = new Map(db
		.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, SETUP_KEY)))
		.all()
		.map((row) => [row.namespace, row.value]));
	return {
		race: decodeSetup("race", raceBox.setup, stored.get(boxReference("race"))),
		"author-note": decodeSetup("author-note", authorNoteBox.setup, stored.get(boxReference("author-note"))),
		"world-clock": decodeSetup("world-clock", worldClockBox.setup, stored.get(boxReference("world-clock"))),
	};
};
