import { FormatRegistry } from "@sinclair/typebox";

/** Register the custom formats used while decoding shared wire schemas. */
export const registerWireFormats = (): void => {
	if (FormatRegistry.Has("numeric")) return;
	FormatRegistry.Set("numeric", (value) =>
		Boolean(value) && !Number.isNaN(Number(value))
	);
};
