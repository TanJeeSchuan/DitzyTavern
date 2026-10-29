/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- The walker traverses TypeBox schemas and their dynamically shaped values. */
import { TypeGuard, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ParticipantKey } from "../../shared/contract/box-row-reference";

type RowKind = "message" | "variant" | "participant";
export type RowIdMaps = Record<RowKind, ReadonlyMap<number, number>>;

export function rewriteRowReferences<T extends TSchema>(schema: T, value: Static<T>, idMaps: RowIdMaps, { keepMissing }: { keepMissing: boolean }): Static<T> {
	const rewrite = (kind: RowKind, id: number, path: string) => {
		const mapped = idMaps[kind].get(id);
		if (mapped !== undefined) return mapped;
		if (keepMissing) return id;
		throw new Error(`Missing ${kind} ${id} at ${path || "/"}.`);
	};
	const walk = (node: TSchema, current: unknown, path: string): unknown => {
		const reference = node.rowReference;
		if ((reference === "message" || reference === "variant" || reference === "participant") && typeof current === "number") return rewrite(reference, current, path);
		if (TypeGuard.IsUnion(node)) {
			const branch = node.anyOf.find((candidate) => Value.Check(candidate, current));
			if (branch === undefined) throw new Error(`No union branch matches at ${path || "/"}.`);
			return walk(branch, current, path);
		}
		if (TypeGuard.IsArray(node) && Array.isArray(current)) return current.map((item, index) => walk(node.items, item, `${path}/${index}`));
		if (TypeGuard.IsObject(node) && current !== null && typeof current === "object" && !Array.isArray(current)) {
			return Object.fromEntries(Object.entries(current).map(([key, item]) => {
				const property = Object.hasOwn(node.properties, key) ? node.properties[key] : node.additionalProperties;
				return [key, TypeGuard.IsSchema(property) ? walk(property, item, `${path}/${escapePath(key)}`) : item];
			}));
		}
		if (TypeGuard.IsRecord(node) && current !== null && typeof current === "object" && !Array.isArray(current)) {
			const [pattern, itemSchema] = Object.entries(node.patternProperties)[0]!;
			return Object.fromEntries(Object.entries(current).map(([key, item]) => {
				const itemPath = `${path}/${escapePath(key)}`;
				if (!new RegExp(pattern).test(key)) return [key, TypeGuard.IsSchema(node.additionalProperties) ? walk(node.additionalProperties, item, itemPath) : item];
				const mapped = pattern === ParticipantKey.pattern ? idMaps.participant.get(Number(key)) : undefined;
				if (pattern === ParticipantKey.pattern && mapped === undefined && !keepMissing) rewrite("participant", Number(key), itemPath);
				return [mapped === undefined ? key : String(mapped), walk(itemSchema, item, itemPath)];
			}));
		}
		return current;
	};
	// SAFETY: the walk preserves the schema shape and replaces ids with ids.
	return walk(schema, value, "") as Static<T>;
}

const escapePath = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
