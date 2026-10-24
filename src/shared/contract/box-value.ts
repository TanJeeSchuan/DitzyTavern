import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { generationJsonValue } from "./json-value";
import { Value } from "@sinclair/typebox/value";

// @approved
//  A Box's own value as the host holds it: a setup, record, Move or window
// read. It is JSON, where an absent optional field reads as undefined. The
// host checks it against that Box's schema, and the Box reads it with the
// same one, through `boxSetupOf` and `boxMovesOf`. This module imports no
// Box, so every Box layer can reach it through the SDK.
export const boxValue = generationJsonValue;
export type BoxValue = Static<typeof boxValue>;

/** @approved Whether a Box value passes one of its Box's schemas; the host keeps holding it as a BoxValue. */
export const fitsBoxSchema = (schema: TSchema, value: BoxValue): boolean => Value.Check(schema, value);

/** @approved A Box's own setup in a Chat, checked against and typed by the Box's own setup schema. */
export const boxSetupOf = <Schema extends TSchema>({ boxSetups }: { readonly boxSetups: Readonly<Record<string, BoxValue>> }, box: string, schema: Schema): Static<Schema> => {
	const setup: unknown = boxSetups[box];
	if (!Value.Check(schema, setup)) throw new Error(`The ${box} Box setup does not match its schema.`);
	return setup;
};

/** @approved A Box's own Moves, checked against and typed by the Box's own Move schema. */
export const boxMovesOf = <Schema extends TSchema>(moves: Readonly<Record<string, readonly BoxValue[]>>, box: string, schema: Schema): readonly Static<Schema>[] => {
	const list: unknown = moves[box] ?? [];
	if (!Value.Check(Type.Array(schema), list)) throw new Error(`The ${box} Moves do not match their schema.`);
	return list;
};
