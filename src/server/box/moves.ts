import { guardBoxPromptImages, type BoxImageGrants } from "../prompt-compiler/images";
import type { PromptWarning } from "../prompt-compiler";
import { Type } from "@sinclair/typebox";
import { type BoxValue } from "../../shared/contract/box-value";
import { parseStoredBoxJson } from "./stored-json";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { hasMoves, moveLabel, type BoxMoves } from "../../shared/contract/box-generation";
import { boxReference, type BoxStates } from "../../shared/contract/box";
import { messageDataTable } from "../database/schema";
import { chatBoxes, serverBoxes, type ChatBoxes } from "./registry";

// @approved
//  Moves live on the Human-authored Message in messages_data under
//  `box:<id>`, key `moves`, one ordered list per Box.
const MOVES_KEY = "moves";

// @approved
//  A Box that is not enabled in the Chat cannot render, so its stored Moves
//  enter history as their chip labels. Boxes render in registry order, each
//  as the Chat runs it.
const renderMoves = (moves: BoxMoves, author: string, boxes: ChatBoxes, states: BoxStates, grants: BoxImageGrants, warnings: PromptWarning[]): string[] => [...boxes].flatMap(([id, { descriptor, box }]) => {
	const rendering = states[id] === "enabled" ? box.moves : undefined;
	return descriptor.moves === undefined ? [] : (moves[id] ?? []).map((move) => guardBoxPromptImages(rendering?.render(move, author) ?? moveLabel(descriptor, move), grants.get(boxReference(id)), warnings));
});

/** @approved The text the model reads for a Human-authored Message: each Move's `render`, then the writer's prose. */
export const humanMessageText = (moves: BoxMoves, content: string, author: string | null, boxes: ChatBoxes, states: BoxStates, grants: BoxImageGrants, warnings: PromptWarning[]): string => {
	if (!hasMoves(moves)) return content;
	if (author === null) throw new Error("A Message with Moves always carries its author's name.");
	return [...renderMoves(moves, author, boxes, states, grants, warnings), content].filter((part) => part.trim() !== "").join("\n");
};

/** @approved The Moves on this Chat's Messages, each list decoded by the version the Chat runs. */
export const readMessageMoves = (db: BunSQLiteDatabase, conversationId: number, messageIds: readonly number[]): Map<number, BoxMoves> => {
	const result = new Map<number, BoxMoves>();
	if (messageIds.length === 0) return result;
	const boxes = [...chatBoxes(db, conversationId)].flatMap(([id, { descriptor: { moves } }]) => moves === undefined ? [] : [[id, moves] as const]);
	const rows = db.select().from(messageDataTable).where(and(
		inArray(messageDataTable.message_id, [...messageIds]),
		inArray(messageDataTable.namespace, boxes.map(([id]) => boxReference(id))),
		eq(messageDataTable.key, MOVES_KEY),
	)).all();
	for (const [id, declared] of boxes) {
		const namespace = boxReference(id);
		const schema = Type.Array(Type.Unsafe<BoxValue>(declared.schema), { minItems: 1, maxItems: declared.max });
		for (const row of rows.filter((row) => row.namespace === namespace)) {
			const moves = { ...result.get(row.message_id), [id]: parseStoredBoxJson(row.value, schema, `Message ${row.message_id} ${namespace} ${MOVES_KEY}`) };
			result.set(row.message_id, moves);
		}
	}
	return result;
};

/** @approved Replaces a loaded Box's Moves on a Message with `moves`, which its command already checked against each Box's Move schema; an unloaded Box's stay. */
export const writeMessageMoves = (db: BunSQLiteDatabase, messageId: number, moves: BoxMoves): void => {
	db.delete(messageDataTable).where(and(eq(messageDataTable.message_id, messageId), inArray(messageDataTable.namespace, [...serverBoxes().keys()].map(boxReference)), eq(messageDataTable.key, MOVES_KEY))).run();
	for (const [id, list] of Object.entries(moves)) {
		if (list.length > 0) db.insert(messageDataTable).values({ message_id: messageId, namespace: boxReference(id), key: MOVES_KEY, value: JSON.stringify(list) }).run();
	}
};
