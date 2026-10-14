import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
export function parseStoredBoxJson<T extends TSchema>(value: string, schema: T, place: string): Static<T> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new Error(`Stored Box JSON at ${place} is malformed.`, { cause });
	}
	if (!Value.Check(schema, parsed)) throw new Error(`Stored Box value at ${place} does not match its schema.`);
	return parsed;
}
