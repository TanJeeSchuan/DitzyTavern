import type { Database } from "bun:sqlite";
import { foldRecords, readBoxLifecycles, readRecordSlots, readSelectedHistoryFromConnection, runConversationReadTransaction, type Box } from "@/box-sdk/server";
import { tipRecord, type TipMove, type TipRecord } from "./shared";

const tipJarBox = {
	moves: { render: ({ coins }, author) => `(${author} drops ${coins} coin in the tip jar.)` },
	records: { initial: 0, fold: (total, { coins }) => total + coins },
	read: readTipJar,
	advance: {
		run: async ({ state, moves }) => {
			const coins = moves.reduce((sum, move) => sum + move.coins, 0);
			return { items: [{ text: `The tip jar holds ${state + coins} coins.`, priority: 0, pinned: true }], record: { coins } };
		},
	},
} satisfies Box<undefined, undefined, never, TipRecord, number, TipMove>;
export default tipJarBox;

function readTipJar(database: Database, conversationId: number): TipRecord | undefined {
	return runConversationReadTransaction(database, (db) => {
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		const ids = history.messages.flatMap(({ variant }) => variant === null ? [] : [variant.id]);
		const slots = readRecordSlots(db, "tip-jar", tipRecord, readBoxLifecycles(db, conversationId)["tip-jar"]?.instance, ids);
		return { coins: foldRecords(tipJarBox.records, undefined, slots, ids) };
	});
}
