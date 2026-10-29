import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { MessageId, ParticipantId, ParticipantKey, VariantId } from "../../box-sdk/shared";
import { rewriteRowReferences } from "./row-references";

/* eslint-disable ditzy/no-contract-definition-outside-contract -- Exercises the Box schema boundary. */
const schema = Type.Object({
	identities: Type.Record(ParticipantKey, Type.Array(Type.Union([
		Type.Object({ message: MessageId, variant: Type.Optional(VariantId) }),
		Type.Object({ participant: ParticipantId }),
	]))),
});
const maps = { message: new Map([[1, 11]]), variant: new Map([[2, 22]]), participant: new Map([[3, 33], [4, 44]]) };

test("rewrites references in record keys, arrays and union branches", () => {
	expect(rewriteRowReferences(schema, { identities: { "3": [{ message: 1, variant: 2 }, { participant: 4 }] } }, maps, { keepMissing: false }))
		.toEqual({ identities: { "33": [{ message: 11, variant: 22 }, { participant: 44 }] } });
});

test("reports a missing reference's path or keeps it for traces", () => {
	const value = { identities: { "3": [{ message: 9 }] } };
	expect(() => rewriteRowReferences(schema, value, maps, { keepMissing: false })).toThrow("/identities/3/0/message");
	expect(rewriteRowReferences(schema, value, maps, { keepMissing: true })).toEqual({ identities: { "33": [{ message: 9 }] } });
	expect(() => rewriteRowReferences(schema, { identities: { "9": [] } }, maps, { keepMissing: false })).toThrow("/identities/9");
	expect(rewriteRowReferences(schema, { identities: { "009": [] } }, maps, { keepMissing: true })).toEqual({ identities: { "009": [] } });
});

test("rewrites only matching record entries and schema-valued additional properties", () => {
	const extra = Type.Object({}, { additionalProperties: MessageId });
	const record = Type.Record(ParticipantKey, MessageId, { additionalProperties: VariantId });
	expect(rewriteRowReferences(extra, { source: 1 }, maps, { keepMissing: false })).toEqual({ source: 11 });
	expect(() => rewriteRowReferences(extra, { source: 9 }, maps, { keepMissing: false })).toThrow("/source");
	expect(rewriteRowReferences(record, { "3": 1, note: 2 }, maps, { keepMissing: false })).toEqual({ "33": 11, note: 22 });
});
