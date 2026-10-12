import { Type, type Static } from "@sinclair/typebox";

export const MAX_PHONE_MOVES = 12;

// @approved
//  An outgoing text staged from the Phone. Its sender is the author of the
//  Human-authored Message that carries it.
export const phoneMove = Type.Object({
	to: Type.String({ minLength: 1, maxLength: 100 }),
	text: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type PhoneMove = Static<typeof phoneMove>;

// @approved
//  One text on the Selected narrative path. `key` is the Variant and the
//  text's place in it, so a swipe yields new keys and the client can count
//  what it has not shown yet.
export const phoneText = Type.Object({ key: Type.String(), from: Type.String(), to: Type.String(), text: Type.String() });
export type PhoneText = Static<typeof phoneText>;

/** @approved One thread per Cast member other than the human-controlled Participant, oldest text first. */
export const phoneRead = Type.Object({
	conversationId: Type.Integer(),
	revision: Type.Integer(),
	human: Type.Union([Type.Null(), Type.String()]),
	threads: Type.Array(Type.Object({ contact: Type.String(), texts: Type.Array(phoneText) })),
});
export type PhoneRead = Static<typeof phoneRead>;
