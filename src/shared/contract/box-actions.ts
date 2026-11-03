import { Type, type Static } from "@sinclair/typebox";
import { boxState } from "./box";
import { boxValue } from "./box-value";

const library = Type.Object({ type: Type.Literal("library") }, { additionalProperties: false });
const character = Type.Object({ type: Type.Literal("character"), characterId: Type.Integer() }, { additionalProperties: false });
const participant = Type.Object({ type: Type.Literal("participant"), participantId: Type.Integer() }, { additionalProperties: false });
const key = Type.String({ minLength: 1, maxLength: 100 });
const boxDataWrite = Type.Object({ owner: Type.Union([library, character, participant]), key, value: Type.String() }, { additionalProperties: false });
const boxDataExpectation = Type.Object({ owner: Type.Union([library, character]), key, revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export type BoxDataWrite = Static<typeof boxDataWrite>;
export type BoxDataExpectation = Static<typeof boxDataExpectation>;

// @approved
//  Replaces one Box's whole setup. The command checks the setup against that
// Box's schema before anything is written, so storage only ever holds
// decodable values.
export const setBoxSetupAction = Type.Object({ type: Type.Literal("set-box-setup"), box: Type.String(), setup: boxValue });

// @approved
//  One atomic batch of a Box's own values, with its setup when it carries
// one. The Box id owns the namespace (`box:<id>`), so a commit never addresses
// another Box's data, and each write names the Library, a Character this
// Chat's Cast was seeded from, or a Participant of this Chat. Values are the
// Box's own stored strings, which it decodes on read. The Chat revision
// guards the setup and Participant values; Library and Character values are
// shared across Chats, so `expected` names each one's revision as last read,
// 0 when it was absent, and every Library or Character write needs its own.
export const commitBoxAction = Type.Object({
	type: Type.Literal("commit-box"),
	box: Type.String(),
	setup: Type.Optional(boxValue),
	writes: Type.Optional(Type.Array(boxDataWrite, { maxItems: 100 })),
	expected: Type.Optional(Type.Array(boxDataExpectation, { maxItems: 100 })),
});

// @approved
//  Inserts (`enabled`), disables or removes (`absent`) one Box in this Chat.
export const setBoxStateAction = Type.Object({ type: Type.Literal("set-box-state"), box: Type.String(), state: boxState });

// @approved
//  Sets one Variant's Writer override for a Box record. The command checks
//  the record against that Box's schema before anything is written, so
//  storage only ever holds decodable values. `expected` is the effective
//  record the writer's draft started from, null for none: digests change
//  records without a Conversation revision, so the command refuses an
//  override once the slot no longer holds it.
//  Reset removes the override and leaves the automatic record, if any, as the
//  effective value.
export const setBoxRecordAction = Type.Object({
	type: Type.Literal("set-box-record"),
	box: Type.String(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	record: boxValue,
	expected: boxValue,
});

export const resetBoxRecordAction = Type.Object({
	type: Type.Literal("reset-box-record"),
	box: Type.String(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});
