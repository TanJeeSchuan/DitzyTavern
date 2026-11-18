import { Kind, Type, TypeRegistry, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

const isPlainObject = (value: unknown): value is object =>
	value !== null && value !== undefined && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
TypeRegistry.Set("JsonObject", (_schema, value) => isPlainObject(value));

const plainObject = Type.Object({});
const jsonObject = Type.Unsafe<Static<typeof plainObject>>({ [Kind]: "JsonObject" });

const jsonValue = Type.Recursive((value) => Type.Union([
	Type.Null(),
	Type.Boolean(),
	Type.Number(),
	Type.String(),
	Type.Readonly(Type.Array(value)),
	Type.Intersect([Type.Readonly(Type.Record(Type.String(), value)), jsonObject]),
]));

type ReadonlyJson<T> = T extends readonly (infer Item)[] ? readonly ReadonlyJson<Item>[] : T extends string | number | boolean | null ? T : { readonly [Key in keyof T]: ReadonlyJson<T[Key]> };

// Elysia's exact-mirror cannot resolve `This` through a Record, so routes see
// the recursive check only as an opaque kind.
const checkJsonValue = TypeCompiler.Compile(jsonValue);
TypeRegistry.Set("GenerationJsonValue", (_schema, value) => checkJsonValue.Check(value));

export const generationJsonValue = Type.Unsafe<ReadonlyJson<Static<typeof jsonValue>>>({ [Kind]: "GenerationJsonValue" });

export type GenerationJsonValue = Static<typeof generationJsonValue>;

export const generationJsonObject = Type.Readonly(Type.Record(Type.String(), generationJsonValue));
export type GenerationJsonObject = Static<typeof generationJsonObject>;

// @approved
//  Where a value first stops being JSON, as a JSON Pointer, or undefined when
// all of it is: a finite number, a string, a boolean, null, an array without
// holes or a plain object of those. A Promise, a class instance, a function,
// undefined or a non-finite number is where it stops.
/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This is the boundary check that proves a value is JSON. */
const nonJsonPath = (value: unknown, path = ""): string | undefined => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? undefined : path || "/";
	const entries = Array.isArray(value) ? Array.from(value, (item, index) => [String(index), item] as const) : isPlainObject(value) ? Object.entries(value) : undefined;
	if (entries === undefined) return path || "/";
	for (const [key, item] of entries) {
		const found = nonJsonPath(item, `${path}/${key}`);
		if (found !== undefined) return found;
	}
	return undefined;
};
/* eslint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** @approved Throws naming `what` and where it stops being JSON, unless all of `value` is JSON. */
export function assertJson(value: unknown, what: string): asserts value is GenerationJsonValue {
	const path = nonJsonPath(value);
	if (path !== undefined) throw new Error(`${what} is not JSON at ${path}.`);
}
