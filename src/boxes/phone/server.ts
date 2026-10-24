import { phoneMove, type PhoneMove, type PhoneRead } from "./contract";
import type { Database } from "bun:sqlite";
import {
	readConversationSummaryFromConnection, readMessageMoves, readSelectedHistoryFromConnection, runConversationReadTransaction, type Box,
} from "@/box-sdk/server";
import { boxMovesOf } from "@/box-sdk/shared";
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
} satisfies Box<undefined, PhoneNames, never, never, undefined, PhoneMove>;
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
		// @approved
		//  A sent text reads from the Phone's own Moves, rendered as the model
		//  reads them while the Phone runs, so the window keeps them while it is
		//  off and history shows only their chip labels. A Message with Moves
		//  always has its author.
		const sent = (id: number, author: string | null) => author === null ? [] : boxMovesOf(moves.get(id) ?? {}, "phone", phoneMove).map((move) => phoneBox.moves.render(move, author));
		const texts = history.messages.flatMap(({ id, author, variant }) => variant === null ? [] : stripPhoneTexts([...sent(id, author?.capturedName ?? null), variant.content].join("\n"), names)
			.flatMap((segment) => segment.kind === "sms" ? [segment.text] : [])
			.map((text, index) => ({ key: `${variant.id}:${index}`, ...text })));
		return {
			conversationId, revision: summary.revision, human: human.name,
			threads: names.contacts.map((contact) => ({ contact, texts: texts.filter(({ from, to }) => from === contact || to === contact) })),
		};
	});
}
