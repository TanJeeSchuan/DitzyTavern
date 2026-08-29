import { FormatRegistry, Kind, TransformKind, Type } from "@sinclair/typebox";

// Route params and query values cross the wire as strings and must decode to
// numbers the way the HTTP runtime's Numeric schema does. This is that schema
// expressed with TypeBox only: a numeric-string-or-number union validated at
// the boundary and decoded through the transform the runtime honors, while
// the declared static type is the decoded number.
//
// The "numeric" string format must be registered in TypeBox's global format
// registry for the string member to validate. The server runtime registers
// the same predicate when it loads; registering it here too keeps the schema
// self-contained wherever it is loaded, and the Has guard makes both orders
// idempotent.
if (!FormatRegistry.Has("numeric")) {
	FormatRegistry.Set("numeric", (value) => Boolean(value) && !Number.isNaN(Number(value)));
}

export const numericWire = Type.Unsafe<number>({
	[Kind]: "Union",
	anyOf: [Type.String({ format: "numeric", default: 0 }), Type.Number()],
	[TransformKind]: {
		Decode: (value: string | number) => {
			const decoded = Number(value);
			if (Number.isNaN(decoded)) {
				throw new Error("Expected a numeric value.");
			}
			return decoded;
		},
		Encode: (value: number) => value,
	},
});
