import { Type, type Static, type TSchema } from "@sinclair/typebox";

// @approved
//  One Box record slot per Variant. `source` hashes the digested text, so an
// edit is digested again and a reselection is not. `error` is the last failed
// digest and the hash of the text it failed on: live work does not retry that
// text, a catch-up run does, and a successful digest clears it.
export const boxRecordSlot = <Record extends TSchema>(record: Record) => Type.Object({
	automatic: Type.Optional(record),
	writer: Type.Optional(record),
	source: Type.Optional(Type.String()),
	error: Type.Optional(Type.Object({ source: Type.String(), message: Type.String() })),
});

// @approved
//  A catch-up run's window progress: how many passages it set out to digest
//  how many are still queued or in flight, and how many failed.
export const boxCatchUp = Type.Object({
	total: Type.Integer({ minimum: 0 }),
	remaining: Type.Integer({ minimum: 0 }),
	failed: Type.Integer({ minimum: 0 }),
});
export type BoxCatchUp = Static<typeof boxCatchUp>;

/** @approved Digests one selected passage now, as live work. */
export const digestPassageCommand = Type.Object({ variantId: Type.Integer() });

// @approved
//  A digesting Box's dock read: only its folded one-line status, so a
//  minimized Box polls no prose.
export const digestStatusRead = Type.Object({ status: Type.Union([Type.Null(), Type.String()]) });

// @approved
//  A digesting Box's window read: its folded one-line status and the selected
//  path's passages. Each passage carries
//  its resolved record (`writer ?? automatic`, null when not digested),
//  whether a writer set it, whether the automatic result is the one for
//  exactly this text, so the window knows what a catch-up run would add, and
//  the error of a digest that failed on exactly this text.
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
		error: Type.Union([Type.Null(), Type.String()]),
	})),
});
export type DigestRead<Record extends TSchema> = Static<ReturnType<typeof digestRead<Record>>>;
