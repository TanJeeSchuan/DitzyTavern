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

/** @approved Throws why `value` fails `schema`, naming what it is and where it fails. */
function assertChecked<Schema extends TSchema>(schema: Schema, value: unknown, what: string): asserts value is Static<Schema> {
	if (Value.Check(schema, value)) return;
	const error = Value.Errors(schema, value).First();
	throw new Error(`${what} is invalid${error === undefined ? "" : ` at ${error.path || "/"}: ${error.message}`}.`);
}

/** @approved Throws why the host refuses a Box module's descriptor. The server checks each folder's, the client each client module's. */
export function assertBoxDescriptor(descriptor: unknown): asserts descriptor is BoxDescriptor {
	assertChecked(boxDescriptorSchema, descriptor, "Its descriptor");
	if (descriptor.setup !== undefined && !Value.Check(descriptor.setup.schema, descriptor.setup.initial)) throw new Error("Its initial setup does not match its setup schema.");
	if (descriptor.sdk !== boxSdkVersion) throw new Error(`It was built for Box SDK ${descriptor.sdk}; this host runs ${boxSdkVersion}.`);
}

// @approved
//  What the host reads from a Box's client module beside its descriptor,
// before it renders any of it: each surface is a component, a function or a
// React component object such as a lucide icon, and a window has a size.
// The client checks each module against it and refuses one that fails.
const component = Type.Union([Type.Function([], Type.Unknown()), Type.Object({ $$typeof: Type.Symbol() })]);
export const boxClientSchema = Type.Object({
	descriptor: Type.Unknown(),
	icon: component,
	Window: Type.Optional(Type.Object({
		size: Type.Object({ width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) }),
		Panel: component,
		DockTab: component,
		lens: Type.Optional(Type.Object({ tag: Type.String({ minLength: 1 }), gate: Type.Function([], Type.Unknown()) })),
	})),
	PrimaryPanel: Type.Optional(component),
	TopBarItem: Type.Optional(component),
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
	inject: Type.Optional(Type.Array(Type.String())),
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
//  What a lens returns for a stretch of prose, checked each time the story
// lenses it: the prose it leaves and the marks it lifts, each a React element.
const lensPieces = Type.Array(Type.Union([
	Type.Object({ kind: Type.Literal("prose"), text: Type.String() }),
	Type.Object({ kind: Type.Literal("lifted"), element: Type.Object({ $$typeof: Type.Symbol() }) }),
]));
export function assertLensPieces(pieces: unknown): asserts pieces is Static<typeof lensPieces> {
	assertChecked(lensPieces, pieces, "Its lens output");
}

/** @approved Throws why the host refuses a Box's client module: a surface, or its descriptor as `assertBoxDescriptor` checks it. */
export function assertBoxClient(client: unknown): asserts client is Static<typeof boxClientSchema> & { readonly descriptor: BoxDescriptor } {
	assertChecked(boxClientSchema, client, "Its client module");
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
