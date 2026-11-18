import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { numericWire, promptChannels } from "@/box-sdk/shared";

/** @approved What the window or a Participant editor asks for: whom to draft in which Chat, the writer's steer, and the Cast member being drafted, if any. */
export const draftRequest = Type.Object({
	conversationId: Type.Integer(),
	person: Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" }),
	instruction: Type.Optional(Type.String({ maxLength: 2048 })),
	participantId: Type.Optional(Type.Integer()),
});
export type DraftRequest = Static<typeof draftRequest>;

/** @approved The draft the agent submits: a Definition's name and Prompt channels, and the lines it quotes, each with the Message it is copied from. */
export const characterDraft = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" }),
	prompt: promptChannels,
	quotes: Type.Array(Type.Object({ messageId: Type.Integer(), text: Type.String({ minLength: 1 }) })),
});
export type CharacterDraft = Static<typeof characterDraft>;

/** @approved One `run` the agent made, as the writer watches it. */
export const draftActivity = Type.Object({ summary: Type.String(), code: Type.String(), output: Type.String() });
export type DraftActivity = Static<typeof draftActivity>;

/** @approved One frame of the draft stream: a step the agent ran, then the draft or why it failed, which ends the stream. */
export const draftEvent = Type.Union([
	Type.Object({ type: Type.Literal("activity"), activity: draftActivity }),
	Type.Object({ type: Type.Literal("draft"), draft: characterDraft }),
	Type.Object({ type: Type.Literal("failed"), message: Type.String() }),
]);
export type DraftEvent = Static<typeof draftEvent>;

/** @approved The window's read for one Chat: the person labels Memory knows, empty without Memory, and why a draft cannot start, or null when the agent's model is ready. */
export const drafterRead = Type.Object({ people: Type.Array(Type.String()), unavailable: Type.Union([Type.String(), Type.Null()]) });
export type DrafterRead = Static<typeof drafterRead>;
export const drafterConversationParams = Type.Object({ id: numericWire });

/** @approved The `messages` global: the Selected narrative path, in order. */
export const draftMessages = Type.Array(Type.Object({
	id: Type.Integer(), index: Type.Integer(), author: Type.Union([Type.String(), Type.Null()]), authorParticipantId: Type.Union([Type.Integer(), Type.Null()]), text: Type.String(),
}));
export type DraftMessages = Static<typeof draftMessages>;
/** @approved The `cast` global: each Participant in the Cast, with its current name first and then the other names its Messages were written under. */
export const draftCast = Type.Array(Type.Object({ id: Type.Integer(), names: Type.Array(Type.String()) }));
export type DraftCast = Static<typeof draftCast>;
/** @approved People labels as Memory's `people()` answers them. */
export const draftPeople = Type.Array(Type.String());

/** @approved The `exports` global's schema: each Box's Exports as functions typed by the schemas that Box declares. */
export const draftExports = (boxes: Readonly<Record<string, Readonly<Record<string, { readonly input: TSchema; readonly output: TSchema }>>>>) =>
	Type.Object(Object.fromEntries(Object.entries(boxes).map(([id, exports]) =>
		[id, Type.Object(Object.fromEntries(Object.entries(exports).map(([name, { input, output }]) => [name, Type.Function([input], output)])))])));
