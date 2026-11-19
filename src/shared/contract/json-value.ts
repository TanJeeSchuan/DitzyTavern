import { Kind, Type, TypeRegistry, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

const isPlainObject = (value: unknown): value is object =>
	value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
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
const pointer = (path: string, key: string | symbol) => `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const arrayIndex = (key: string | symbol, length: number) => typeof key === "string" && String(Math.trunc(Number(key))) === key && Number(key) >= 0 && Number(key) < length;

const nonJsonPath = (value: unknown, ancestors: Set<object>, path = ""): string | undefined => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
	if (typeof value === "number") return Number.isFinite(value) ? undefined : path || "/";
	if (!Array.isArray(value) && !isPlainObject(value)) return path || "/";
	if (ancestors.has(value)) return path || "/";
	ancestors.add(value);
	const array = Array.isArray(value);
	const properties = Reflect.ownKeys(value);
	if (array) {
		const extra = properties.find((key) => key !== "length" && !arrayIndex(key, value.length));
		if (extra !== undefined) return pointer(path, extra);
		if (properties.length !== value.length + 1) {
			let index = 0;
			while (Object.hasOwn(value, index)) index += 1;
			return pointer(path, String(index));
		}
	}
	for (const key of properties) {
		if (array && key === "length") continue;
		const child = pointer(path, key);
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key === "symbol" || property === undefined || !property.enumerable || !("value" in property)) return child;
		const found = nonJsonPath(property.value, ancestors, child);
		if (found !== undefined) return found;
	}
	ancestors.delete(value);
	return undefined;
};
/* eslint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

/** @approved Throws naming `what` and where it stops being JSON, unless all of `value` is JSON. */
export function assertJson(value: unknown, what: string): asserts value is GenerationJsonValue {
	const path = nonJsonPath(value, new Set());
	if (path !== undefined) throw new Error(`${what} is not JSON at ${path}.`);
}
