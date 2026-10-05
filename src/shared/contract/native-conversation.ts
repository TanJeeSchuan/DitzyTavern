import { Type } from "@sinclair/typebox";
import { conversationSummary, generationFormattingContext } from "./conversation-schema";
import { portrait } from "./image";
import { promptChannels } from "./prompt-schema";

// One seat of a new native Conversation: fork an existing Character at a
// pinned revision, or define an ad-hoc Participant inline.
export const newChatSeatSchema = Type.Union([
	Type.Object({
		type: Type.Literal("character"),
		characterId: Type.Integer(),
		expectedRevision: Type.Integer(),
	}),
	Type.Object({
		type: Type.Literal("adhoc"),
		definition: Type.Object({
			name: Type.String(),
			prompt: promptChannels,
			openings: Type.Array(Type.String()),
			portrait: Type.Optional(portrait),
		}),
	}),
]);

export const nativeConversationBody = Type.Object({
	name: Type.String(),
	humanSeat: newChatSeatSchema,
	modelSeat: newChatSeatSchema,
	// The initiating client owns the formatting context used to compile model
	// openings. Both values are optional so the evaluator can apply its
	// deterministic UTC/en-US defaults when a caller has no locale hint.
	...generationFormattingContext.properties,
});

export const nativeConversationResponse = Type.Object({
	outcome: Type.Literal("created"),
	conversation: conversationSummary,
});
