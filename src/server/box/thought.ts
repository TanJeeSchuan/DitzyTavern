import type { Database } from "bun:sqlite";
import { readConversationSummaryFromConnection, readSelectedHistoryFromConnection, runConversationReadTransaction } from "../conversation";
import { stripThoughts, type ThoughtRead } from "../../shared/thought";
import type { Box } from "./contract";

// @approved
//  Inner monologue lives in the prose as `<thought>` markup, which the prompt
//  keeps and the story's lens lifts into the Thoughts window.
export const thoughtBox = {
	read: readThoughts,
	advance: {
		run: async () => ({
			items: [{
				text: "When a character thinks something they do not say aloud, write it inside the prose as <thought>the thought</thought>. Never restate a thought in the narration.",
				priority: 0,
				pinned: true,
			}],
		}),
	},
} satisfies Box<undefined>;

function readThoughts(database: Database, conversationId: number): ThoughtRead | undefined {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		const thoughts = history.messages.flatMap(({ author, variant }) => variant === null ? [] : stripThoughts(variant.content)
			.flatMap((segment) => segment.kind === "thought" ? [segment.text] : [])
			.map((text, index) => ({ key: `${variant.id}:${index}`, author: author?.capturedName ?? null, text })));
		return { conversationId, revision: summary.revision, thoughts };
	});
}
