/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- The walker traverses TypeBox schemas and their dynamically shaped values. */
import { Kind, KindGuard, type Static, type TSchema } from "@sinclair/typebox";
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
		if (!needsWalk(node)) return current;
		const reference = node.rowReference;
		if (reference === "message" || reference === "variant" || reference === "participant") {
			if (typeof current === "number") return rewrite(reference, current, path);
			if (typeof current === "string") return String(rewrite(reference, Number(current), path));
		}
		if (KindGuard.IsUnion(node)) {
			const branch = node.anyOf.find((candidate) => Value.Check(candidate, current));
			if (branch === undefined) throw new Error(`No union branch matches at ${path || "/"}.`);
			return walk(branch, current, path);
		}
		if (KindGuard.IsArray(node) && Array.isArray(current)) return current.map((item, index) => walk(node.items, item, `${path}/${index}`));
		if (KindGuard.IsObject(node) && current !== null && typeof current === "object" && !Array.isArray(current)) {
			return Object.fromEntries(Object.entries(current).map(([key, item]) => {
				const property = Object.hasOwn(node.properties, key) ? node.properties[key] : node.additionalProperties;
				return [key, KindGuard.IsSchema(property) ? walk(property, item, `${path}/${escapePath(key)}`) : item];
			}));
		}
		if (KindGuard.IsRecord(node) && current !== null && typeof current === "object" && !Array.isArray(current)) {
			const [pattern, itemSchema] = Object.entries(node.patternProperties)[0]!;
			if (pattern === integerKeyPattern) throw new Error(`Integer Record keys at ${path || "/"} lose their Row Reference; key ids with ParticipantKey.`);
			return Object.fromEntries(Object.entries(current).map(([key, item]) => {
				const itemPath = `${path}/${escapePath(key)}`;
				if (!new RegExp(pattern).test(key)) return [key, KindGuard.IsSchema(node.additionalProperties) ? walk(node.additionalProperties, item, itemPath) : item];
				const mapped = pattern === ParticipantKey.pattern ? idMaps.participant.get(Number(key)) : undefined;
				if (pattern === ParticipantKey.pattern && mapped === undefined && !keepMissing) rewrite("participant", Number(key), itemPath);
				return [mapped === undefined ? key : String(mapped), walk(itemSchema, item, itemPath)];
			}));
		}
		if (JSON.stringify(node).includes('"rowReference"')) throw new Error(`A Row Reference under ${String(node[Kind])} at ${path || "/"} cannot be rewritten.`);
		return current;
	};
	// SAFETY: the walk preserves the schema shape and replaces ids with ids.
	return walk(schema, value, "") as Static<T>;
}

// TypeBox writes this pattern for any Integer or Number key and drops the key schema's annotations.
const integerKeyPattern = "^(0|[1-9][0-9]*)$";

// @approved
//  A schema with no Row Reference has nothing to rewrite, so its value is
// returned untouched. Records keyed by ParticipantKey or an Integer count as
// holding one, since TypeBox drops their key annotations. Box traces are
// megabytes of reference-free values, and walking them leaf by leaf was most
// of a fork's time.
const walked = new WeakMap<TSchema, boolean>();
const needsWalk = (node: TSchema) => {
	let needed = walked.get(node);
	if (needed === undefined) {
		const text = JSON.stringify(node);
		needed = [JSON.stringify("rowReference"), JSON.stringify(integerKeyPattern), JSON.stringify(ParticipantKey.pattern)].some((marker) => text.includes(marker));
		walked.set(node, needed);
	}
	return needed;
};
const escapePath = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
