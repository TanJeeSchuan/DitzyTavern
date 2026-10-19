import { Kind, Type, TypeGuard, TypeRegistry, type Static, type TObject, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { boxValue, type BoxValue } from "./box-value";
import { boxMetadataSchema } from "./box-metadata";
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

//  What the host shows, defaults and stores for each Box, from its folder's
// `shared-descriptor.ts`. `id` names the folder, the `box:<id>` preset
// reference and the Box's data namespace; `sdk` is the SDK major it was
// built against. `label` is its preset block label and the name the host
// shows for it everywhere, and `summary` is one plain sentence saying what
// the Box does, which the Box manager keeps even when the Box's client
// module did not load. `role` is the role its block starts with, and
// `startsEnabled` whether a new Chat starts with it enabled. `instructions`
// is the text a new block starts with, after which it belongs to the preset;
// the block renders it before the Box's items, and renders nothing without
// items unless the Box declares `alwaysRender`. `block` is how the preset
// editor describes the block, in place of its generic copy. `setup` is its
// Conversation-scoped setup, which the set-box-setup command accepts.
// `record` is the schema of the record each Variant holds for it, which
// Writer overrides accept. `moves` are the Moves the human attaches to a
// Message, each shown as its chip `label`; seat-bound Moves are dropped from
// the composer when the human seat changes. A record is an object, so an
// absent record is never confused with a record's value. `decision` gives
// the Box a global Decision Model selection, which its digests ask, and the
// settings copy that selection shows.
export const boxDescriptorSchema = Type.Object({
	...boxMetadataSchema.properties,
	sdk: Type.Integer(),
	role: promptOutgoingRole,
	startsEnabled: Type.Boolean(),
	alwaysRender: Type.Optional(Type.Literal(true)),
	setup: Type.Optional(Type.Object({ schema, initial: boxValue })),
	record: Type.Optional(Type.Unsafe<TObject>({ [Kind]: "BoxRecordSchema" })),
	moves: Type.Optional(Type.Object({
		schema,
		max: Type.Integer({ minimum: 1 }),
		label: Type.Unsafe<(move: never) => string>(Type.Function([], Type.String())),
		seatBound: Type.Optional(Type.Literal(true)),
	})),
});
export type BoxDescriptor = Static<typeof boxDescriptorSchema>;

/** @approved Throws why `value` fails `schema`, naming what it is and where it fails. */
export function assertChecked<Schema extends TSchema>(schema: Schema, value: unknown, what: string): asserts value is Static<Schema> {
	if (Value.Check(schema, value)) return;
	const error = Value.Errors(schema, value).First();
	throw new Error(`${what} is invalid${error === undefined ? "" : ` at ${error.path || "/"}: ${error.message}`}.`);
}

/** @approved Throws why the host refuses a Box module's descriptor. The server checks each folder's, the client each client module's. */
export function assertBoxDescriptor(descriptor: unknown): asserts descriptor is BoxDescriptor {
	assertChecked(boxDescriptorSchema, descriptor, "Its descriptor");
	if (Object.hasOwn(Object.prototype, descriptor.id)) throw new Error(`Its id, ${descriptor.id}, names an Object.prototype property.`);
	if (descriptor.setup !== undefined && !Value.Check(descriptor.setup.schema, descriptor.setup.initial)) throw new Error("Its initial setup does not match its setup schema.");
	if (descriptor.sdk !== boxSdkVersion) throw new Error(`It was built for Box SDK ${descriptor.sdk}; this host runs ${boxSdkVersion}.`);
}

//  What the host reads from a Box's client module beside its descriptor,
// before it renders any of it: each surface is a component, a function or a
// React component object such as a lucide icon, and a window has a size.
// `header` puts the Box's `Status` in the Chat tools, so it needs both. The
// client checks each module against it and refuses one that fails.
const component = Type.Union([Type.Function([], Type.Unknown()), Type.Object({ $$typeof: Type.Symbol() })]);
export const boxClientSchema = Type.Object({
	descriptor: Type.Unknown(),
	icon: component,
	Window: Type.Optional(Type.Object({
		size: Type.Object({ width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) }),
		Panel: component,
		lens: Type.Optional(Type.Object({ tag: Type.String({ minLength: 1 }), gate: Type.Function([], Type.Unknown()) })),
	})),
	Status: Type.Optional(component),
	header: Type.Optional(Type.Literal(true)),
	PrimaryPanel: Type.Optional(component),
	Inspector: Type.Optional(Type.Object({ label: Type.String(), Component: component })),
	Settings: Type.Optional(component),
	ParticipantSection: Type.Optional(component),
	TraceView: Type.Optional(component),
});

// @approved
//  What the host calls on a Box's server module, checked when it loads: each
// hook it declares is a function, or an object holding the functions the host
// calls on it, and a trace schema is a TypeBox schema. The server refuses a
// module that fails, then pairs its hooks with the descriptor.
const hook = Type.Function([], Type.Unknown());
export const boxServerSchema = Type.Object({
	setupError: Type.Optional(hook),
	moves: Type.Optional(Type.Object({ render: hook })),
	dependencies: Type.Optional(hook),
	records: Type.Optional(Type.Object({
		initial: Type.Unknown(),
		fold: hook,
		digest: Type.Optional(Type.Object({ window: Type.Integer({ minimum: 0 }), run: hook })),
	})),
	advance: Type.Optional(Type.Object({ trace: Type.Optional(schema), run: hook, fingerprint: Type.Optional(hook) })),
	status: Type.Optional(hook),
	importSillyTavernNote: Type.Optional(hook),
	read: Type.Optional(hook),
	routes: Type.Optional(hook),
});

// @approved
//  What the host checks each server hook's output against, by hook. State and
// dependencies are JSON, or undefined at the root. A record is JSON that
// passes the Box's record schema, and a Box without one returns none.
// `advance.run` returns items the compiler can place, a whole-token
// allowance, and a JSON trace that passes the Box's trace schema.
export const boxHookOutputs = (descriptor: BoxDescriptor, trace: TSchema | undefined) => {
	const state = Type.Union([boxValue, Type.Undefined()]);
	const record = descriptor.record === undefined ? Type.Never() : Type.Intersect([boxValue, descriptor.record]);
	return {
		setupError: Type.Union([Type.String(), Type.Undefined()]),
		"moves.render": Type.String(),
		dependencies: state,
		"records.initial": state,
		"records.fold": state,
		"records.digest.run": record,
		"advance.run": Type.Object({
			items: Type.Array(Type.Object({ text: Type.String(), priority: Type.Number(), pinned: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()) })),
			allowance: Type.Optional(Type.Integer({ minimum: 0 })),
			trace: Type.Optional(trace === undefined ? boxValue : Type.Intersect([boxValue, trace])),
			record: Type.Optional(record),
		}),
		status: Type.Union([Type.String(), Type.Null()]),
		importSillyTavernNote: descriptor.setup?.schema ?? Type.Never(),
	};
};

//  What a lens returns for a stretch of prose, checked each time the story
//  lenses it: the prose it leaves and one line for each mark it lifts.
const lensPieces = Type.Array(Type.Union([
	Type.Object({ kind: Type.Literal("prose"), text: Type.String() }),
	Type.Object({ kind: Type.Literal("lifted"), line: Type.String() }),
]));
export function assertLensPieces(pieces: unknown): asserts pieces is Static<typeof lensPieces> {
	assertChecked(lensPieces, pieces, "Its lens output");
}

/** @approved Throws why the host refuses a Box's client module: a surface, or its descriptor as `assertBoxDescriptor` checks it. */
export function assertBoxClient(client: unknown): asserts client is Static<typeof boxClientSchema> & { readonly descriptor: BoxDescriptor } {
	assertChecked(boxClientSchema, client, "Its client module");
	if (client.header === true && (client.Status === undefined || client.Window === undefined)) throw new Error("Its header item needs both a Status and a Window.");
	assertBoxDescriptor(client.descriptor);
}

/** @approved A Box's server module as the host checked it: each hook it declares has the shape the host calls. */
export type BoxServerModule = Static<typeof boxServerSchema>;
/** @approved Throws why the host refuses a Box's server module: a hook that is not a function, or a hook object without one. */
export function assertBoxServer(server: unknown): asserts server is BoxServerModule {
	assertChecked(boxServerSchema, server, "Its server module");
}

/** @approved A descriptor's `setup`, its initial value typed by its schema. */
export const describeSetup = <Schema extends TSchema>(schema: Schema, initial: Static<Schema> & BoxValue) => ({ schema, initial });
/** @approved A descriptor's `moves`, its chip label typed by the Move schema. */
export const describeMoves = <Schema extends TSchema>(schema: Schema, max: number, label: (move: Static<Schema>) => string) => ({ schema, max, label });
