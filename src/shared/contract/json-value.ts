import { Kind, Type, TypeRegistry, type Static } from "@sinclair/typebox";

TypeRegistry.Set("JsonObject", (_schema, value) =>
	value !== null && value !== undefined && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));

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

export const generationJsonValue = Type.Unsafe<ReadonlyJson<Static<typeof jsonValue>>>(jsonValue);

export type GenerationJsonValue = Static<typeof generationJsonValue>;
