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
//  What a slot's automatic record is for its passage's current text: none, a
//  result for exactly this text, a result for an earlier text that still
//  folds until the new one lands, or a digest that failed on this text, with
//  whether an earlier result still folds. A failure on an earlier text is no
//  failure of this one.
export const boxDigestStatus = Type.Union([
	Type.Object({ kind: Type.Literal("missing") }),
	Type.Object({ kind: Type.Literal("fresh") }),
	Type.Object({ kind: Type.Literal("stale") }),
	Type.Object({ kind: Type.Literal("failed"), error: Type.String(), stale: Type.Boolean() }),
]);
export type DigestStatus = Static<typeof boxDigestStatus>;

// @approved
//  One record slot's status for its passage's current text. A Writer override
//  settles the passage, so its failed digest needs no attention; the digest
//  queue still keeps the automatic record beneath it current, so Reset
//  restores one for this text.
export const boxSlotStatus = Type.Union([...boxDigestStatus.anyOf, Type.Object({ kind: Type.Literal("overridden"), automatic: boxDigestStatus })]);
export type SlotStatus = Static<typeof boxSlotStatus>;

/** @approved The automatic record's status, beneath an override or not. */
export const automaticStatus = (status: SlotStatus): DigestStatus => status.kind === "overridden" ? status.automatic : status;

/** @approved Whether the automatic record that folds came from an earlier text. */
export const isStale = (status: DigestStatus): boolean => status.kind === "stale" || (status.kind === "failed" && status.stale);

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
//  path's passages. Each passage carries the plain-text start of its prose,
//  enough for the timeline's two lines, its resolved record (`writer ?? automatic`, null when not digested),
//  and its slot status.
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
		excerpt: Type.String(),
		record: Type.Union([Type.Null(), record]),
		status: boxSlotStatus,
	})),
});
export type DigestRead<Record extends TSchema> = Static<ReturnType<typeof digestRead<Record>>>;

// @approved
//  What a delegating Box's window notice reads: whether its delegate setting
// is off, ready or broken with the reason, and the first passage on the
// Selected path whose delegate run failed on its current text, numbered by
// its place on the path, with the reason. A Writer override settles it.
// `landed` counts the passages whose record is the delegate's run on their
// current text, so a window refetches its read when one lands.
export const delegateRead = Type.Object({
	landed: Type.Integer({ minimum: 0 }),
	setting: Type.Union([Type.Object({ kind: Type.Literal("off") }), Type.Object({ kind: Type.Literal("ready") }), Type.Object({ kind: Type.Literal("broken"), reason: Type.String() })]),
	failed: Type.Union([Type.Object({ messageId: Type.Integer(), variantId: Type.Integer(), number: Type.Integer(), error: Type.String() }), Type.Null()]),
});
export type DelegateRead = Static<typeof delegateRead>;
