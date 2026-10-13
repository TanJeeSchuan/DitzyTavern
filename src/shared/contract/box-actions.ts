import { Type, type Static } from "@sinclair/typebox";
import { boxState } from "./box";
import { boxValue } from "./box-value";

// @approved
//  A Box window writes one value into its own namespace. The Box id owns the
//  namespace (`box:<id>`), so a window can never address another Box's data,
//  and the owner names the Library, Character or Participant row the value
//  belongs to. The value is the Box's own stored string; the Box decodes it
//  on read. Library and Character values are shared across Chats, so the
//  Chat revision cannot guard them: a write carries the value's own revision
//  as last read, 0 when it was absent.
const sharedRevision = Type.Integer({ minimum: 0 });
const boxDataWrite = Type.Object({
	owner: Type.Union([
		Type.Object({ type: Type.Literal("library"), revision: sharedRevision }),
		Type.Object({ type: Type.Literal("character"), characterId: Type.Integer(), revision: sharedRevision }),
		Type.Object({ type: Type.Literal("participant"), participantId: Type.Integer() }),
	]),
	key: Type.String({ minLength: 1, maxLength: 100 }),
	value: Type.String(),
});
export type BoxDataWrite = Static<typeof boxDataWrite>;

// @approved
//  Replaces one Box's whole setup. The command checks the setup against that
// Box's schema before anything is written, so storage only ever holds
// decodable values. `writes` are the Box's own data writes that land in the
// same transaction, so a setup that depends on them never commits without
// them.
export const setBoxSetupAction = Type.Object({ type: Type.Literal("set-box-setup"), box: Type.String(), setup: boxValue, writes: Type.Optional(Type.Array(boxDataWrite)) });

// @approved
//  Inserts (`enabled`), disables or removes (`absent`) one Box in this Chat.
export const setBoxStateAction = Type.Object({ type: Type.Literal("set-box-state"), box: Type.String(), state: boxState });

// @approved
//  Sets one Variant's Writer override for a Box record. The command checks
//  the record against that Box's schema before anything is written, so
//  storage only ever holds decodable values. `expected` is the effective
//  record the writer read, null for none: digests change records without a
//  Conversation revision, so a stale override is refused against it instead.
//  Reset removes the override and leaves the automatic record, if any, as the
//  effective value.
export const setBoxRecordAction = Type.Object({
	type: Type.Literal("set-box-record"),
	box: Type.String(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	record: boxValue,
	expected: Type.Optional(boxValue),
});

export const resetBoxRecordAction = Type.Object({
	type: Type.Literal("reset-box-record"),
	box: Type.String(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

export const putBoxDataAction = Type.Object({ type: Type.Literal("put-box-data"), box: Type.String(), ...boxDataWrite.properties });
