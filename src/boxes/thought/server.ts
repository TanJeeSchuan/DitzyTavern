import type { Database } from "bun:sqlite";
import { readConversationSummaryFromConnection, readSelectedHistoryFromConnection, runConversationReadTransaction, type Box } from "@/box-sdk/server";
import { stripThoughts, type ThoughtRead } from "./shared";

// @approved
//  Inner monologue lives in the prose as `<thought>` markup, which the prompt
//  keeps and the story's lens lifts into the Thoughts window. The block's
//  instructions are the whole prompt, so the Box has no advance.
const thoughtBox = {
	read: readThoughts,
} satisfies Box<undefined>;
export default thoughtBox;

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
