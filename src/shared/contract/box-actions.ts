import { Type, type Static, type TInteger, type TLiteral, type TNull, type TObject, type TOptional, type TUnion } from "@sinclair/typebox";
import { boxDescriptors, boxId, boxSetups, boxState, recordBoxId, recordBoxIds, setupBoxIds, type BoxDescriptors, type RecordBoxId, type SetupBoxId } from "./box";

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
//  Replaces one Box's whole setup. The setup is validated against that Box's
// schema here, so storage only ever holds decodable values. `writes` are the
// Box's own data writes that land in the same transaction, so a setup that
// depends on them never commits without them.
const boxSetupWrites = Type.Optional(Type.Array(boxDataWrite));
type SetBoxSetupActions<Ids extends readonly SetupBoxId[]> = { -readonly [K in keyof Ids]: TObject<{ type: TLiteral<"set-box-setup">; box: TLiteral<Ids[K]>; setup: BoxDescriptors[Ids[K]]["setup"]["schema"]; writes: typeof boxSetupWrites }> };
// SAFETY: one action per setup Box in tuple order, each with its own setup schema.
const setBoxSetupAction = Type.Union(setupBoxIds.map((id) => Type.Object({ type: Type.Literal("set-box-setup"), box: Type.Literal(id), setup: boxSetups.properties[id], writes: boxSetupWrites })) as SetBoxSetupActions<typeof setupBoxIds>);

// @approved
//  Inserts (`enabled`), disables or removes (`absent`) one Box in this Chat.
export const setBoxStateAction = Type.Object({ type: Type.Literal("set-box-state"), box: boxId, state: boxState });

// @approved
//  Sets one Variant's Writer override for a Box record. The record is
//  validated against that Box's schema here, so storage only ever holds
//  decodable values. `expected` is the effective record the writer read,
//  null for none: digests change records without a Conversation revision,
//  so a stale override is refused against it instead. Reset removes the
//  override and leaves the automatic record, if any, as the effective value.
type SetBoxRecordActions<Ids extends readonly RecordBoxId[]> = {
	-readonly [K in keyof Ids]: TObject<{
		type: TLiteral<"set-box-record">; box: TLiteral<Ids[K]>; messageId: TInteger; variantId: TInteger; record: BoxDescriptors[Ids[K]]["record"];
		expected: TOptional<TUnion<[BoxDescriptors[Ids[K]]["record"], TNull]>>;
	}>
};
// SAFETY: one action per record Box in tuple order, each with its own record schema.
const setBoxRecordAction = Type.Union(recordBoxIds.map((id) => Type.Object({
	type: Type.Literal("set-box-record"),
	box: Type.Literal(id),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	record: boxDescriptors[id].record,
	expected: Type.Optional(Type.Union([boxDescriptors[id].record, Type.Null()])),
})) as SetBoxRecordActions<typeof recordBoxIds>);

export const resetBoxRecordAction = Type.Object({
	type: Type.Literal("reset-box-record"),
	box: recordBoxId,
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

export const putBoxDataAction = Type.Object({ type: Type.Literal("put-box-data"), box: boxId, ...boxDataWrite.properties });

export { setBoxRecordAction, setBoxSetupAction };
