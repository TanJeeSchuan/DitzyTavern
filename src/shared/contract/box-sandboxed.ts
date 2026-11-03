/* eslint-disable anti-slop/no-runtime-typeof -- The rebuild walks JSON a Box wrote, before any schema types it. */
import { Type, type SchemaOptions, type Static, type TSchema } from "@sinclair/typebox";
import { boxValue, type BoxValue } from "./box-value";
import { assertBoxDescriptor, boxDescriptorSchema, type BoxDescriptor } from "./box-descriptor";
import { boxMetadataSchema } from "./box-metadata";

/** @approved The icons a sandboxed Box may name for its window, its launcher and its dock button. */
export const sandboxedBoxIcon = Type.Union([
	Type.Literal("box"), Type.Literal("coins"), Type.Literal("dice"), Type.Literal("flag"), Type.Literal("gauge"),
	Type.Literal("heart"), Type.Literal("map"), Type.Literal("scroll"), Type.Literal("sparkles"), Type.Literal("star"),
]);
export type SandboxedBoxIcon = Static<typeof sandboxedBoxIcon>;

// @approved
//  A sandboxed Box's `descriptor.json`: the fields of a descriptor, with every
// schema written as the JSON a TypeBox schema serializes to and the Move chip
// label as a template, where `{key}` reads that field of the Move. `window`
// gives the frame its size in rem and the Box its icon. JSON holds no code,
// and an unknown key is refused, so no field can carry one.
const json = boxValue;
export const sandboxedDescriptorFile = Type.Object({
	...Type.Omit(boxDescriptorSchema, ["setup", "values", "record", "moves"]).properties,
	setup: Type.Optional(Type.Object({ schema: json, initial: boxValue }, { additionalProperties: false })),
	values: Type.Optional(Type.Object({ chat: Type.Optional(Type.Record(Type.String(), json)), participant: Type.Optional(Type.Record(Type.String(), json)) }, { additionalProperties: false })),
	record: Type.Optional(json),
	moves: Type.Optional(Type.Object({ schema: json, max: Type.Integer({ minimum: 1 }), label: Type.String(), seatBound: Type.Optional(Type.Literal(true)) }, { additionalProperties: false })),
	window: Type.Object({
		icon: sandboxedBoxIcon,
		size: Type.Object({ width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) }, { additionalProperties: false }),
	}, { additionalProperties: false }),
}, { additionalProperties: false });
export type SandboxedDescriptorFile = Static<typeof sandboxedDescriptorFile>;

/** @approved The loaded Boxes, in registry order, each with the metadata the server projects from its descriptor and, for a trusted Box, the URL its client module loads from, or, for a sandboxed one, its descriptor file. */
export const boxList = Type.Array(Type.Union([
	Type.Composite([boxMetadataSchema, Type.Object({ client: Type.String() })]),
	Type.Composite([boxMetadataSchema, Type.Object({ sandboxed: sandboxedDescriptorFile })]),
]));

const annotations = ["title", "description", "rowReference"];
const numeric = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];

type JsonObject = { readonly [key: string]: BoxValue };
const isObject = (value: BoxValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

// @approved
//  Rebuilds a schema from its JSON with TypeBox, so the host's checks, Fork
// walker and editors read it as they read a built-in Box's. Only the forms
// the Fork walker handles (objects, records, arrays and unions) and the
// primitives and literals inside them are accepted, each with the keywords
// listed for it; anything else is refused with its path.
export const sandboxedSchema = (schema: BoxValue | undefined, path: string): TSchema => {
	if (!isObject(schema)) throw new Error(`Its schema at ${path} is not a schema object.`);
	const options = (structure: readonly string[], keywords: readonly string[] = []): SchemaOptions => {
		const unknown = Object.keys(schema).filter((key) => ![...structure, ...keywords, ...annotations].includes(key));
		if (unknown.length > 0) throw new Error(`Its schema at ${path} uses ${unknown.join(", ")}, which a sandboxed Box cannot.`);
		return Object.fromEntries(Object.entries(schema).filter(([key]) => [...keywords, ...annotations].includes(key)));
	};
	const { type } = schema;
	if ("const" in schema) {
		const value = schema.const;
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`Its literal at ${path} is not a string, number or boolean.`);
		return Type.Literal(value, options(["const", "type"]));
	}
	if ("anyOf" in schema) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new Error(`Its union at ${path} has no members.`);
		return Type.Union(schema.anyOf.map((member, index) => sandboxedSchema(member, `${path}/anyOf/${index}`)), options(["anyOf"]));
	}
	if (type === "array") return Type.Array(sandboxedSchema(schema.items, `${path}/items`), options(["type", "items"], ["minItems", "maxItems"]));
	if (type === "object" && "patternProperties" in schema) {
		const entries = isObject(schema.patternProperties) ? Object.entries(schema.patternProperties) : [];
		const [entry] = entries;
		if (entry === undefined || entries.length > 1) throw new Error(`Its record at ${path} must have exactly one key pattern.`);
		return Type.Record(Type.String({ pattern: entry[0] }), sandboxedSchema(entry[1], `${path}/patternProperties/${entry[0]}`), options(["type", "patternProperties"]));
	}
	if (type === "object") {
		const properties = isObject(schema.properties) ? schema.properties : {};
		const required = schema.required ?? [];
		if (!Array.isArray(required) || required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))) throw new Error(`Its object at ${path} requires a key it does not declare.`);
		if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error(`Its object at ${path} may only set additionalProperties to false.`);
		const built = Object.fromEntries(Object.entries(properties).map(([key, property]) => {
			const rebuilt = sandboxedSchema(property, `${path}/properties/${key}`);
			return [key, required.includes(key) ? rebuilt : Type.Optional(rebuilt)];
		}));
		return Type.Object(built, options(["type", "properties", "required"], ["additionalProperties"]));
	}
	if (type === "string") return Type.String(options(["type"], ["minLength", "maxLength", "pattern"]));
	if (type === "integer") return Type.Integer(options(["type"], numeric));
	if (type === "number") return Type.Number(options(["type"], numeric));
	if (type === "boolean") return Type.Boolean(options(["type"]));
	if (type === "null") return Type.Null(options(["type"]));
	throw new Error(`Its schema at ${path} is not a form a sandboxed Box can use.`);
};

/** @approved A Move chip label from its template: each `{key}` reads that field of the Move. */
const templateLabel = (template: string) => (move: BoxValue) =>
	template.replaceAll(/\{(\w+)\}/g, (_, key: string) => String(isObject(move) && Object.hasOwn(move, key) ? move[key] : ""));

// @approved
//  The descriptor a sandboxed Box's `descriptor.json` describes, once the
// file passed its schema, checked as every Box's descriptor is checked. The
// server and the client both build it, so a Move label and a schema read the
// same on either side.
export const sandboxedDescriptor = (file: SandboxedDescriptorFile): BoxDescriptor => {
	const { setup, values, record, moves, window: _, ...fields } = file;
	const schemas = (entries: Readonly<Record<string, BoxValue>> | undefined, path: string) =>
		entries && Object.fromEntries(Object.entries(entries).map(([key, schema]) => [key, sandboxedSchema(schema, `${path}/${key}`)]));
	const descriptor = {
		...fields,
		...setup && { setup: { schema: sandboxedSchema(setup.schema, "/setup/schema"), initial: setup.initial } },
		...values && { values: { ...values.chat && { chat: schemas(values.chat, "/values/chat") }, ...values.participant && { participant: schemas(values.participant, "/values/participant") } } },
		...record !== undefined && { record: sandboxedSchema(record, "/record") },
		...moves && { moves: { schema: sandboxedSchema(moves.schema, "/moves/schema"), max: moves.max, label: templateLabel(moves.label), ...moves.seatBound && { seatBound: true as const } } },
	};
	assertBoxDescriptor(descriptor);
	return descriptor;
};

// @approved
//  What crosses out of a sandboxed Box's runtime, all of it as JSON: which
// hooks its `logic.js` exports, each with its `typeof`, and its initial
// state; then each hook call's outcome, its value or the error it threw.
export const sandboxedDeclaration = Type.Object({ declared: Type.Array(Type.Tuple([Type.String(), Type.String()])), initial: Type.Optional(Type.Unknown()) });
export const sandboxedFailure = Type.Object({ name: Type.String(), message: Type.String() });
export type SandboxedFailure = Static<typeof sandboxedFailure>;
export const sandboxedOutcome = Type.Union([
	Type.Object({ kind: Type.Literal("ok"), value: Type.Optional(Type.Unknown()) }),
	Type.Composite([Type.Object({ kind: Type.Literal("error") }), sandboxedFailure]),
]);
