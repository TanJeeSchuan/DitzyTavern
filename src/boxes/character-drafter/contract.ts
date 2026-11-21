import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { codeAgentActivity, numericWire, promptChannels } from "@/box-sdk/shared";

/** @approved The longest person name a draft takes; the picker and the Participant entry offer none longer. */
export const PERSON_MAX = 256;
/** @approved The longest steer a draft takes. */
export const INSTRUCTION_MAX = 2048;
/** @approved Why a name cannot be drafted, shown wherever one is offered. */
export const PERSON_TOO_LONG = `Names over ${PERSON_MAX} characters can't be drafted.`;

/** @approved What the window or a Participant editor asks for: whom to draft in which Chat, the writer's steer, and the Cast member being drafted, if any. */
export const draftRequest = Type.Object({
	conversationId: Type.Integer(),
	person: Type.String({ minLength: 1, maxLength: PERSON_MAX, pattern: "\\S" }),
	instruction: Type.Optional(Type.String({ maxLength: INSTRUCTION_MAX })),
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

/** @approved One frame of the draft stream: a step the agent ran, then the draft or why it failed, which ends the stream. */
export const draftEvent = Type.Union([
	Type.Object({ type: Type.Literal("activity"), activity: codeAgentActivity }),
	Type.Object({ type: Type.Literal("draft"), draft: characterDraft }),
	Type.Object({ type: Type.Literal("failed"), message: Type.String() }),
]);
export type DraftEvent = Static<typeof draftEvent>;

/** @approved The label list the Drafter expects for grouping Claims and populating the picker. */
export const draftPeople = Type.Array(Type.String());

/** @approved The window's read for one Chat: the person labels Memory knows, empty without Memory, and why a draft cannot start, or null when the agent's model is ready. */
export const drafterRead = Type.Object({ people: draftPeople, unavailable: Type.Union([Type.String(), Type.Null()]) });
export type DrafterRead = Static<typeof drafterRead>;
export const drafterConversationParams = Type.Object({ id: numericWire });
/** @approved The summary Elysia's validation answer carries when a draft request fails its schema. */
export const draftRequestRefusal = Type.Object({ summary: Type.String() });

/** @approved The `messages` global: the Selected narrative path, in order. */
export const draftMessages = Type.Array(Type.Object({
	id: Type.Integer(), index: Type.Integer(), author: Type.Union([Type.String(), Type.Null()]), authorParticipantId: Type.Union([Type.Integer(), Type.Null()]), text: Type.String(),
}));
export type DraftMessages = Static<typeof draftMessages>;
/** @approved The `cast` global: each Participant in the Cast, with its current name first and then the other names its Messages were written under. */
export const draftCast = Type.Array(Type.Object({ id: Type.Integer(), names: Type.Array(Type.String()) }));
export type DraftCast = Static<typeof draftCast>;
/** @approved The part of Memory's selected Claims that the Drafter uses to group them. */
export const draftClaimPeople = Type.Array(Type.Object({ people: draftPeople }));

/** @approved The `memory` global groups Claims from Memory's Export under the Drafter's labels. */
export const draftMemory = (claims?: TSchema) => claims === undefined ? Type.Null()
	: Type.Union([Type.Object({ people: draftPeople, claims: Type.Record(Type.String(), claims) }), Type.Null()]);
