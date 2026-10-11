import { Type, type Static, type TSchema } from "@sinclair/typebox";

// @approved
//  One Box record slot per Variant. `source` hashes the digested text, so an
// edit is digested again and a reselection is not.
export const boxRecordSlot = <Record extends TSchema>(record: Record) => Type.Object({
	automatic: Type.Optional(record),
	writer: Type.Optional(record),
	source: Type.Optional(Type.String()),
});

// @approved
//  A catch-up run's window progress: how many passages it set out to digest
//  and how many are still queued or in flight.
export const boxCatchUp = Type.Object({
	total: Type.Integer({ minimum: 0 }),
	remaining: Type.Integer({ minimum: 0 }),
});
export type BoxCatchUp = Static<typeof boxCatchUp>;

// @approved
//  A digesting Box's window read: its folded one-line status and the selected
//  path's passages. The dock and the window share it. Each passage carries
//  its resolved record (`writer ?? automatic`, null when not digested),
//  whether a writer set it, and whether the automatic result is the one for
//  exactly this text, so the window knows what a catch-up run would add.
//  `digestReady` reports whether the Box's Decision Model is selected.
export const digestRead = <Record extends TSchema>(record: Record) => Type.Object({
	conversationId: Type.Integer(),
	revision: Type.Integer(),
	status: Type.Union([Type.Null(), Type.String()]),
	digestReady: Type.Boolean(),
	catchUp: Type.Union([Type.Null(), boxCatchUp]),
	passages: Type.Array(Type.Object({
		messageId: Type.Integer(),
		variantId: Type.Integer(),
		author: Type.Union([Type.Null(), Type.String()]),
		content: Type.String(),
		record: Type.Union([Type.Null(), record]),
		overridden: Type.Boolean(),
		digested: Type.Boolean(),
	})),
});
export type DigestRead<Record extends TSchema> = Static<ReturnType<typeof digestRead<Record>>>;
