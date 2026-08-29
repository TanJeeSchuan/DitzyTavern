import { Kind, TransformKind, Type } from "@sinclair/typebox";

// Route params and query values cross the wire as strings and must decode to
// numbers the way the HTTP runtime's Numeric schema does. This is that schema
// expressed with TypeBox only: a numeric-string-or-number union validated at
// the boundary and decoded through the transform the runtime honors, while
// the declared static type is the decoded number.
//
// Application entrypoints register the "numeric" string format before they
// decode contracts. Keeping that mutation out of this module makes importing
// a schema free of process-wide side effects.

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
