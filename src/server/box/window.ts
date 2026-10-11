import type { RaceRead } from "../../shared/contract/race";
import { initialRaceState, raceStatus } from "./race-engine";
import { and, eq, like } from "drizzle-orm";
import { boxReference } from "../../shared/contract/box";
import { RACE_AVATAR_PREFIX } from "../../shared/race-data";
import { libraryDataTable } from "../database/schema";
import type { Database } from "bun:sqlite";
import type { WorldClockPassage, WorldClockRead } from "../../shared/contract/box";
import {
	readConversationSummaryFromConnection,
	readSelectedHistoryFromConnection,
	runConversationReadTransaction,
} from "../conversation";
import { readBoxCatchUp } from "./digest";
import { resolveBoxDecision } from "./decision-settings";
import { foldRecordStates, hasAutomaticRecord, effectiveRecord, readRecordSlots } from "./records";
import { readRaceCastStats } from "./race-cast";
import { worldClockBox, type WorldClockState } from "./world-clock";

/** @approved The World Clock window and dock read one folded Selected path
 *  state without loading discarded Variants or arbitrary Variant data. */
export function readWorldClock(database: Database, conversationId: number): WorldClockRead | undefined {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		// @approved
		//  An Active Generation's provisional Variant has no settled prose to
		//  digest yet, so it is not a passage.
		const selected = history.messages.flatMap((message) => message.variant === null || message.variant.content.trim() === ""
			? []
			: [{ messageId: message.id, author: message.author?.capturedName ?? null, variant: message.variant }]);
		const slots = readRecordSlots(db, "world-clock", selected.map(({ variant }) => variant.id));
		const { initial, fold } = worldClockBox.records;
		let state: WorldClockState = initial;
		const passages = selected.map(({ messageId, author, variant }): WorldClockPassage => {
			const slot = slots.get(variant.id);
			const record = effectiveRecord(slot) ?? null;
			if (record !== null) state = fold(state, record);
			return { messageId, variantId: variant.id, author, content: variant.content, record, overridden: slot?.writer !== undefined, digested: hasAutomaticRecord(slot, variant.content) };
		});
		return {
			conversationId,
			revision: summary.revision,
			status: worldClockBox.status(summary.boxSetups["world-clock"], state),
			digestReady: resolveBoxDecision(database, "world-clock").kind === "ready",
			catchUp: readBoxCatchUp(database, conversationId),
			passages,
		};
	});
}

export function readRace(database: Database, conversationId: number): RaceRead | undefined {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		const setup = summary.boxSetups.race;
		const ids = history.messages.flatMap(({ variant }) => variant === null ? [] : [variant.id]);
		const { intents, replay, ...state } = foldRecordStates(db, ids, summary.boxSetups).race ?? initialRaceState(setup);
		const humanRunner = setup.slots.find(({ participantId }) => participantId !== undefined && participantId === summary.control.humanParticipantId)?.name;
		return {
			conversationId, revision: summary.revision, status: raceStatus(setup, state, humanRunner), state,
			replay: state.finished ? { stretches: replay, intents } : null,
			castStats: readRaceCastStats(db, summary.cast.map(({ id }) => id)),
			avatars: Object.fromEntries(db.select({ key: libraryDataTable.key, value: libraryDataTable.value }).from(libraryDataTable)
				.where(and(eq(libraryDataTable.namespace, boxReference("race")), like(libraryDataTable.key, `${RACE_AVATAR_PREFIX}%`))).all()
				.map(({ key, value }) => [key.slice(RACE_AVATAR_PREFIX.length), value])),
		};
	});
}
