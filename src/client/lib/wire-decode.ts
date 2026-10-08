import { Value } from "@sinclair/typebox/value";
import type { StaticDecode, TSchema } from "@sinclair/typebox";

export type WirePayload =
	| null
	| undefined
	| boolean
	| number
	| string
	| readonly WirePayload[]
	| { readonly [key: string]: WirePayload };

// @approved
//  The one wire-decode seam every client transport shares: an untrusted
// payload is decoded against a canonical shared contract schema, and a
// payload that fails the contract yields null instead of partial data.
export const decodeWirePayload = <Schema extends TSchema>(
	schema: Schema,
	value: WirePayload,
): StaticDecode<Schema> | null => {
	try {
		return Value.Decode(schema, value);
	} catch {
		return null;
	}
};
