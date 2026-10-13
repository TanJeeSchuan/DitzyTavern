import { Kind, Type, TypeGuard, TypeRegistry, type Static, type TObject, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { boxValue, type BoxValue } from "./box-value";
import { promptOutgoingRole } from "./prompt-preset";

/** @approved The Box SDK's major version. The host refuses a Box whose descriptor declares another. */
export const boxSdkVersion = 1;

// @approved
//  A Box's own schemas, which the host checks the Box's values against: a
// setup or Move schema is any TypeBox schema, and a record schema is a
// `Type.Object`.
TypeRegistry.Set("BoxSchema", (_, value) => TypeGuard.IsSchema(value));
TypeRegistry.Set("BoxRecordSchema", (_, value) => TypeGuard.IsObject(value));
const schema = Type.Unsafe<TSchema>({ [Kind]: "BoxSchema" });

// @approved
//  What the host shows, defaults and stores for each Box, from its folder's
// `shared-descriptor.ts`. `id` names the folder, the `box:<id>` preset
// reference and the Box's data namespace; `sdk` is the SDK major it was
// built against. `label` is its preset block label, `role` the role its
// block starts with, and `startsEnabled` whether a new Chat starts with it
// enabled. `instructions` is the text a new block starts with, after which
// it belongs to the preset; the block renders it before the Box's items, and
// renders nothing without items unless the Box declares `alwaysRender`.
// `block` is how the preset editor describes the block, in place of its
// generic copy. `setup` is its Conversation-scoped setup, which the
// set-box-setup command accepts. `record` is the schema of the record each
// Variant holds for it, which Writer overrides accept. `moves` are the Moves
// the human attaches to a Message, each shown as its chip `label`; seat-bound
// Moves are dropped from the composer when the human seat changes. A record is
// an object, so an absent record is never confused with a record's value.
// `decision` gives the Box a global Decision Model selection, which its
// digests ask, and the settings copy that selection shows.
export const boxDescriptorSchema = Type.Object({
	id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
	sdk: Type.Integer(),
	label: Type.String(),
	role: promptOutgoingRole,
	startsEnabled: Type.Boolean(),
	instructions: Type.String(),
	alwaysRender: Type.Optional(Type.Literal(true)),
	block: Type.Optional(Type.Object({ description: Type.String(), source: Type.String() })),
	setup: Type.Optional(Type.Object({ schema, initial: boxValue })),
	record: Type.Optional(Type.Unsafe<TObject>({ [Kind]: "BoxRecordSchema" })),
	moves: Type.Optional(Type.Object({
		schema,
		max: Type.Integer({ minimum: 1 }),
		label: Type.Unsafe<(move: never) => string>(Type.Function([], Type.String())),
		seatBound: Type.Optional(Type.Literal(true)),
	})),
	decision: Type.Optional(Type.Object({ summary: Type.String(), description: Type.String(), off: Type.String(), context: Type.String() })),
});
export type BoxDescriptor = Static<typeof boxDescriptorSchema>;

/** @approved Throws why the host refuses a Box module's descriptor. The server checks each folder's, the client each client module's. */
export function assertBoxDescriptor(descriptor: unknown): asserts descriptor is BoxDescriptor {
	if (!Value.Check(boxDescriptorSchema, descriptor)) {
		const error = Value.Errors(boxDescriptorSchema, descriptor).First();
		throw new Error(`Its descriptor is invalid${error === undefined ? "" : ` at ${error.path || "/"}: ${error.message}`}.`);
	}
	if (descriptor.setup !== undefined && !Value.Check(descriptor.setup.schema, descriptor.setup.initial)) throw new Error("Its initial setup does not match its setup schema.");
	if (descriptor.sdk !== boxSdkVersion) throw new Error(`It was built for Box SDK ${descriptor.sdk}; this host runs ${boxSdkVersion}.`);
}

/** @approved A descriptor's `setup`, its initial value typed by its schema. */
export const describeSetup = <Schema extends TSchema>(schema: Schema, initial: Static<Schema> & BoxValue) => ({ schema, initial });
/** @approved A descriptor's `moves`, its chip label typed by the Move schema. */
export const describeMoves = <Schema extends TSchema>(schema: Schema, max: number, label: (move: Static<Schema>) => string) => ({ schema, max, label });
