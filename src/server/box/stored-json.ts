import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonValue } from "../../shared/contract/json-value";
export function parseStoredBoxJson<T extends TSchema>(value: string, schema: T, place: string): Static<T> {
	let parsed: GenerationJsonValue;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new Error(`Stored Box JSON at ${place} is malformed.`, { cause });
	}
	return checkStoredBoxValue(parsed, schema, place);
}

export function checkStoredBoxValue<T extends TSchema>(value: GenerationJsonValue, schema: T, place: string): Static<T> {
	if (!Value.Check(schema, value)) throw new Error(`Stored Box value at ${place} does not match its schema.`);
	return value;
}
