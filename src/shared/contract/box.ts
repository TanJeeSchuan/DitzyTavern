import { Type, type Static } from "@sinclair/typebox";
import { boxValue, type BoxValue } from "./box-value";
import type { BoxDescriptor } from "./box-descriptor";
import { decisionSelection } from "./decision-model";
import { numericWire } from "./wire";
import { notFoundOutcome } from "./outcomes";

// @approved
//  A Box's id is a string the host checks against the registry at runtime
// (ADR-0050). A Box's preset reference and its data namespace are both
// `box:<id>`.
export type BoxId = string;
export const promptBoxReference = Type.TemplateLiteral("box:${string}");
export type PromptBoxReference = Static<typeof promptBoxReference>;
export const boxReference = (id: BoxId): PromptBoxReference => `box:${id}`;

// @approved
//  A Box's lifecycle in one Chat. Only an enabled Box runs; a disabled one
// keeps its Chat-scoped data; an absent one has none.
export const boxState = Type.Union([Type.Literal("enabled"), Type.Literal("disabled"), Type.Literal("absent")]);
export type BoxState = Static<typeof boxState>;
export const boxStates = Type.Record(Type.String(), boxState);
export type BoxStates = Static<typeof boxStates>;
export type { BoxDescriptor } from "./box-descriptor";

let installed: ReadonlyMap<BoxId, BoxDescriptor> = new Map();
// @approved
//  The loaded Boxes' descriptors, by id, in the order the host lists and runs
// Boxes. Startup installs them once, before anything reads them, so every
// table built from them is a read rather than a table built at import.
export const boxDescriptors = (): ReadonlyMap<BoxId, BoxDescriptor> => installed;
export const installBoxDescriptors = (descriptors: readonly BoxDescriptor[]): void => {
	installed = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
};

/** @approved The registered Box `id`'s descriptor. An unknown id throws, so a boundary checks ids before the host looks one up. */
export const boxDescriptor = (id: BoxId): BoxDescriptor => {
	const descriptor = installed.get(id);
	if (descriptor === undefined) throw new Error(`There is no ${id} Box.`);
	return descriptor;
};
/** @approved A Box record as the host holds it: an object of the Box's own values. */
export type BoxRecord = { readonly [key: string]: BoxValue };
/** @approved Box `id`'s record schema, typed as the record the host holds; a Box that keeps no records has none. */
export const boxRecordSchema = (id: BoxId) => {
	const { record } = boxDescriptor(id);
	if (record === undefined) throw new Error(`The ${id} Box keeps no records.`);
	return Type.Unsafe<BoxRecord>(record);
};
/** @approved Whether `reference` names a registered Box. */
export const isBoxReference = (reference: string): reference is PromptBoxReference =>
	reference.startsWith("box:") && installed.has(reference.slice("box:".length));
/** @approved Whether `reference` has the `box:<id>` form but names no registered Box, which a preset refuses. */
export const isUnknownBoxReference = (reference: string): boolean => reference.startsWith("box:") && !isBoxReference(reference);
/** @approved The descriptor behind a Box's preset block reference. */
export const boxDescriptorOf = (reference: PromptBoxReference): BoxDescriptor => boxDescriptor(reference.slice("box:".length));
/** @approved Whether `id` is a registered digesting Box, the only kind with a Decision Model selection and a passage timeline. */
export const isDigestBox = (id: BoxId): boolean => installed.get(id)?.decision !== undefined;
/** @approved Each registered Box whose descriptor declares `key`, in registry order, with that key's value. */
export const boxesWith = <Key extends keyof BoxDescriptor>(key: Key): [BoxId, NonNullable<BoxDescriptor[Key]>][] =>
	[...installed].flatMap(([id, descriptor]) => {
		const value = descriptor[key];
		return value === undefined ? [] : [[id, value]];
	});
/** @approved A new Chat starts with these Boxes enabled and every other Box absent. */
export const defaultBoxIds = (): BoxId[] => [...installed].flatMap(([id, { startsEnabled }]) => startsEnabled ? [id] : []);

// @approved
//  A Box window's client-side layout, persisted per Chat: open state,
//  minimization and position are view state, never Conversation state.
export const boxWindowLayout = Type.Object({
	open: Type.Boolean(),
	minimized: Type.Boolean(),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
});
export type BoxWindowLayout = Static<typeof boxWindowLayout>;
export const boxWindowLayouts = Type.Record(Type.String(), boxWindowLayout);
export type BoxWindowLayouts = Static<typeof boxWindowLayouts>;

// @approved
//  Each Box's Conversation-scoped setup, by Box id, as the Chat summary
// carries it.
export const boxSetups = Type.Record(Type.String(), boxValue);
export type BoxSetups = Static<typeof boxSetups>;

/** @approved The loaded Boxes, in registry order, each with its label and the URL its client module loads from. */
export const boxList = Type.Array(Type.Object({ id: Type.String(), label: Type.String(), client: Type.String() }));

export const boxParams = Type.Object({ box: Type.String() });
export const conversationBoxParams = Type.Object({ id: numericWire, box: Type.String() });

export const boxDecisionSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer() })]);
export type BoxDecisionSettings = Static<typeof boxDecisionSettings>;
export const boxDecisionSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: boxDecisionSettings });
export const boxDecisionSettingsConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: boxDecisionSettings });
export const boxDecisionSettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
/** @approved Only a digesting Box has a Decision Model selection, so its routes find no other id. */
export const boxDecisionSettingsCommandErrors = Type.Union([boxDecisionSettingsConflict, boxDecisionSettingsInvalid, notFoundOutcome]);
export const boxDecisionSettingsCommandBody = Type.Composite([decisionSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type BoxDecisionSettingsCommand = Static<typeof boxDecisionSettingsCommandBody>;
