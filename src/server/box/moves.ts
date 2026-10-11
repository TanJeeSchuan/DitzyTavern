import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxMoves, hasMoves, type BoxMoves } from "../../shared/contract/box-generation";
import { boxReference, type BoxStates } from "../../shared/contract/box";
import { raceMoveLabel } from "../../shared/race-moves";
import { phoneMoveLabel } from "../../shared/phone";
import { messageDataTable } from "../database/schema";
import { phoneBox } from "./phone";
import { raceBox } from "./race";

// @approved
//  Moves live on the Human-authored Message in messages_data under
//  `box:<id>`, key `moves`, one ordered list per Box.
const MOVES_KEY = "moves";
export const moveBoxIds = ["race", "phone"] as const satisfies readonly (keyof BoxMoves)[];

// @approved
//  A Box that is not enabled in the Chat cannot render, so its stored Moves
//  enter history as their chip labels.
const renderMoves = (moves: BoxMoves, author: string, boxes: BoxStates): string[] => [
	...(moves.race ?? []).map((move) => boxes.race === "enabled" ? raceBox.moves.render(move) : raceMoveLabel(move)),
	...(moves.phone ?? []).map((move) => boxes.phone === "enabled" ? phoneBox.moves.render(move, author) : phoneMoveLabel(move)),
];

/** @approved The text the model reads for a Human-authored Message: each Move's `render`, then the writer's prose. */
export const humanMessageText = (moves: BoxMoves, content: string, author: string | null, boxes: BoxStates): string => {
	if (!hasMoves(moves)) return content;
	if (author === null) throw new Error("A Message with Moves always carries its author's name.");
	return [...renderMoves(moves, author, boxes), content].filter((part) => part.trim() !== "").join("\n");
};

export const readMessageMoves = (db: BunSQLiteDatabase, messageIds: readonly number[]): Map<number, BoxMoves> => {
	const result = new Map<number, BoxMoves>();
	if (messageIds.length === 0) return result;
	const rows = db.select().from(messageDataTable).where(and(
		inArray(messageDataTable.message_id, [...messageIds]),
		inArray(messageDataTable.namespace, moveBoxIds.map(boxReference)),
		eq(messageDataTable.key, MOVES_KEY),
	)).all();
	for (const row of rows) {
		const moves = { ...result.get(row.message_id), [row.namespace.slice(4)]: JSON.parse(row.value) };
		if (!Value.Check(boxMoves, moves)) throw new Error(`Stored ${row.namespace} Moves do not match their schema. Clear the ${row.namespace} namespace.`);
		result.set(row.message_id, moves);
	}
	return result;
};

export const writeMessageMoves = (db: BunSQLiteDatabase, messageId: number, moves: BoxMoves): void => {
	db.delete(messageDataTable).where(and(
		eq(messageDataTable.message_id, messageId),
		inArray(messageDataTable.namespace, moveBoxIds.map(boxReference)),
		eq(messageDataTable.key, MOVES_KEY),
	)).run();
	for (const id of moveBoxIds) {
		const list = moves[id];
		if (list !== undefined && list.length > 0) db.insert(messageDataTable).values({ message_id: messageId, namespace: boxReference(id), key: MOVES_KEY, value: JSON.stringify(list) }).run();
	}
};

export const sameMoves = (left: BoxMoves | undefined, right: BoxMoves | undefined): boolean =>
	moveBoxIds.every((id) => JSON.stringify(left?.[id] ?? []) === JSON.stringify(right?.[id] ?? []));
