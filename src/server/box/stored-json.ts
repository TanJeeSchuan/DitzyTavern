import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
export class StoredBoxJsonError extends Error {
	constructor(place: string, cause: unknown) {
		super(`Stored Box JSON at ${place} is malformed.`, { cause });
		this.name = "StoredBoxJsonError";
	}
}

export function parseStoredBoxJson<T extends TSchema>(value: string, schema: T, place: string): Static<T> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new StoredBoxJsonError(place, cause);
	}
	if (!Value.Check(schema, parsed)) throw new Error(`Stored Box value at ${place} does not match its schema.`);
	return parsed;
}
