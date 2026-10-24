import { Type, type Static } from "@sinclair/typebox";
import { boxValue, type BoxValue } from "./box-value";
import type { BoxDescriptor } from "./box-descriptor";
import { boxMetadataSchema, type BoxMetadata } from "./box-metadata";
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
export function boxIdOf(reference: PromptBoxReference): BoxId;
export function boxIdOf(reference: string): BoxId | undefined;
export function boxIdOf(reference: string): BoxId | undefined {
	return reference.startsWith("box:") ? reference.slice(4) : undefined;
}
export const boxReference = (id: BoxId): PromptBoxReference => `box:${id}`;

// @approved
//  A Box's lifecycle in one Chat. Only an enabled Box runs; a disabled one
// keeps its Chat-scoped data; an absent one has none.
export const boxState = Type.Union([Type.Literal("enabled"), Type.Literal("disabled"), Type.Literal("absent")]);
export type BoxState = Static<typeof boxState>;
export const boxStates = Type.Record(Type.String(), boxState);
export type BoxStates = Static<typeof boxStates>;
export type { BoxDescriptor } from "./box-descriptor";
export { boxMetadataSchema, type BoxMetadata } from "./box-metadata";

// @approved
//  A loaded Box: the metadata the server lists, and its descriptor, which the
// client holds only once the Box's client module loaded.
export type InstalledBox = { readonly metadata: BoxMetadata; readonly descriptor: BoxDescriptor | undefined };
let installed: ReadonlyMap<BoxId, InstalledBox> = new Map();
// @approved
//  The loaded Boxes, by id, in the order the host lists and runs Boxes.
// Startup installs them once, before anything reads them, so every table
// built from them is a read rather than a table built at import.
export const installedBoxes = (): ReadonlyMap<BoxId, InstalledBox> => installed;
export const installBoxes = (boxes: readonly InstalledBox[]): void => {
	installed = new Map(boxes.map((box) => [box.metadata.id, box]));
};
/** @approved The metadata the server lists for a Box, projected from its descriptor or from the list itself. */
export const boxMetadataFrom = ({ id, label, summary, instructions, block, decision }: BoxMetadata): BoxMetadata => ({ id, label, summary, instructions, block, decision });

const installedBox = (id: BoxId): InstalledBox => {
	const box = installed.get(id);
	if (box === undefined) throw new Error(`There is no ${id} Box.`);
	return box;
};
/** @approved A loaded Box's metadata: its label, summary, instructions, block copy and decision copy. An unknown id throws, so a boundary checks ids first. */
export const boxMetadata = (id: BoxId): BoxMetadata => installedBox(id).metadata;
/** @approved A loaded Box's descriptor. An unknown id throws, and so does a Box whose client module did not load, so a boundary checks ids first. */
export const boxDescriptor = (id: BoxId): BoxDescriptor => {
	const { descriptor } = installedBox(id);
	if (descriptor === undefined) throw new Error(`The ${id} Box's client module did not load.`);
	return descriptor;
};
/** @approved The descriptor of each loaded Box that has one, by id, in registry order. */
export const boxDescriptors = (): ReadonlyMap<BoxId, BoxDescriptor> =>
	new Map([...installed].flatMap(([id, { descriptor }]) => descriptor === undefined ? [] : [[id, descriptor]]));

/** @approved A Box record as the host holds it: an object of the Box's own values. */
export type BoxRecord = { readonly [key: string]: BoxValue };
/** @approved Box `id`'s record schema, typed as the record the host holds; a Box that keeps no records has none. */
export const boxRecordSchema = (id: BoxId) => {
	const { record } = boxDescriptor(id);
	if (record === undefined) throw new Error(`The ${id} Box keeps no records.`);
	return Type.Unsafe<BoxRecord>(record);
};
/** @approved Whether `reference` names a registered Box. */
export const isBoxReference = (reference: string): reference is PromptBoxReference => {
	const id = boxIdOf(reference);
	return id !== undefined && installed.has(id);
};
/** @approved Whether `reference` has the `box:<id>` form but names no registered Box, which a preset refuses. */
export const isUnknownBoxReference = (reference: string): boolean => boxIdOf(reference) !== undefined && !isBoxReference(reference);
/** @approved Whether `id` is a registered digesting Box, the only kind with a Decision Model selection and a passage timeline. */
export const isDigestBox = (id: BoxId): boolean => installed.get(id)?.metadata.decision !== undefined;
/** @approved Each registered Box whose descriptor declares `key`, in registry order, with that key's value. */
export const boxesWith = <Key extends keyof BoxDescriptor>(key: Key): [BoxId, NonNullable<BoxDescriptor[Key]>][] =>
	[...boxDescriptors()].flatMap(([id, descriptor]) => {
		const value = descriptor[key];
		return value === undefined ? [] : [[id, value]];
	});
/** @approved A new Chat starts with these Boxes enabled and every other Box absent. */
export const defaultBoxIds = (): BoxId[] => [...boxDescriptors()].flatMap(([id, { startsEnabled }]) => startsEnabled ? [id] : []);

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

/** The loaded Boxes, in registry order, each with the metadata the server projects from its descriptor and the URL its client module loads from. */
export const boxList = Type.Array(Type.Composite([boxMetadataSchema, Type.Object({ client: Type.String() })]));

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
