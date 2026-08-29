import { Kind, TransformKind, Type } from "@sinclair/typebox";

// Route params and query values cross the wire as strings and must decode to
// numbers the way the HTTP runtime's Numeric schema does. This is that schema
// expressed with TypeBox only: a numeric-string-or-number union validated at
// the boundary and decoded through the transform the runtime honors, while
// the declared static type is the decoded number. The "numeric" string format
// is registered by the server runtime when it loads, so this schema is only
// validated inside that runtime.
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
