import { boxMovesError, type BoxMoves } from "../../../shared/contract/box-generation";
import { writeMessageMoves } from "../../box/moves";
import { authorRoleOf } from "../continuation";
import { InvalidConversationCommandError } from "../errors";
import { hasActiveGenerationFromConnection, readControlAssignment, requireMessage, type ConversationDatabase } from "../internal";
import { toHistoricalContext } from "../message-read-projection";

// @approved
//  Only a Human-authored Message carries Moves, each list passing its Box's
//  Move schema, and they stay fixed while a Generation could be resolving them.
export function setMessageMoves(db: ConversationDatabase, input: { conversationId: number; messageId: number; moves: BoxMoves }): void {
	const invalid = boxMovesError(input.moves);
	if (invalid !== undefined) throw new InvalidConversationCommandError(invalid);
	const message = requireMessage(db, input.conversationId, input.messageId);
	if (hasActiveGenerationFromConnection(db, input.conversationId)) throw new InvalidConversationCommandError("Moves cannot change while a Generation is running.");
	const role = authorRoleOf({ author: { participantId: message.author_participant_id }, historicalContext: toHistoricalContext(message) }, readControlAssignment(db, input.conversationId));
	if (role !== "human") throw new InvalidConversationCommandError("Only a Human-authored Message carries Moves.");
	writeMessageMoves(db, input.messageId, input.moves);
}
