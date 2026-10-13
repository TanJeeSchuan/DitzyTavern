import type { PhoneMove, PhoneRead } from "./contract";
import type { Database } from "bun:sqlite";
import {
	humanMessageText, readConversationSummaryFromConnection, readMessageMoves, readSelectedHistoryFromConnection, runConversationReadTransaction, type Box,
} from "@/box-sdk/server";
import { phoneNames, renderPhoneText, stripPhoneTexts, type PhoneNames } from "./shared";

// @approved
//  Texts live in the prose as `<sms>` markup, which the prompt keeps and the
//  story's lens lifts into the Phone. The block's instructions teach the
//  markup; the Box adds who the human can text. Without another Cast member
//  there is nobody to text, so the block says nothing.
const phoneBox = {
	moves: { render: ({ to, text }, author) => renderPhoneText({ from: author, to, text }) },
	dependencies: ({ cast, human }) => phoneNames(cast, human),
	read: readPhone,
	advance: {
		run: async ({ dependencies: { human, contacts } }) =>
			({ items: contacts.length === 0 ? [] : [{ text: `${human} has a phone and can text ${contacts.join(", ")}.`, priority: 0, pinned: true }] }),
	},
} satisfies Box<undefined, PhoneNames, never, never, never, undefined, PhoneMove>;
export default phoneBox;

/** @approved Threads hold the texts the story's lens lifts from each selected Variant, the human's staged-and-sent Moves included. */
function readPhone(database: Database, conversationId: number): PhoneRead | undefined {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		const human = summary.cast.find(({ id }) => id === summary.control.humanParticipantId);
		if (human === undefined) return { conversationId, revision: summary.revision, human: null, threads: [] };
		const names = phoneNames(summary.cast, human);
		const moves = readMessageMoves(db, history.messages.map(({ id }) => id));
		const texts = history.messages.flatMap(({ id, author, variant }) => variant === null ? [] : stripPhoneTexts(humanMessageText(moves.get(id) ?? {}, variant.content, author?.capturedName ?? null, summary.boxes), names)
			.flatMap((segment) => segment.kind === "sms" ? [segment.text] : [])
			.map((text, index) => ({ key: `${variant.id}:${index}`, ...text })));
		return {
			conversationId, revision: summary.revision, human: human.name,
			threads: names.contacts.map((contact) => ({ contact, texts: texts.filter(({ from, to }) => from === contact || to === contact) })),
		};
	});
}
