import type { PhoneMove, PhoneRead } from "../../shared/contract/phone";
import type { Database } from "bun:sqlite";
import { readConversationSummaryFromConnection, readSelectedHistoryFromConnection, runConversationReadTransaction } from "../conversation";
import { humanMessageText, readMessageMoves } from "./moves";
import { phoneNames, renderPhoneText, stripPhoneTexts, type PhoneNames } from "../../shared/phone";
import type { Box } from "./contract";

// @approved
//  Texts live in the prose as `<sms>` markup, which the prompt keeps and the
//  story's lens lifts into the Phone. Without another Cast member there is
//  nobody to text, so the Phone says nothing.
export const phoneBox = {
	moves: { render: ({ to, text }, author) => renderPhoneText({ from: author, to, text }) },
	dependencies: ({ cast, human }) => phoneNames(cast, human),
	read: readPhone,
	advance: {
		run: async ({ dependencies: { human, contacts } }) => {
			const [contact] = contacts;
			if (contact === undefined) return { items: [] };
			const example = renderPhoneText({ from: contact, to: human, text: "message" });
			const text = `${human} has a phone and can text ${contacts.join(", ")}. Write each text on its own line as ${example}, with the sender in from and the recipient in to. Narrate around a text; never restate it in the prose.`;
			return { items: [{ text, priority: 0, pinned: true }] };
		},
	},
} satisfies Box<undefined, PhoneNames, never, never, never, undefined, PhoneMove>;

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
