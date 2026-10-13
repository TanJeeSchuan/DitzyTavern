import { raceMove, raceRecord, raceSetup } from "../../boxes/race/contract";
import { Type, type Static, type TObject, type TSchema } from "@sinclair/typebox";
import { boxValue, type BoxValue } from "./box-value";
import { authorNoteSetup } from "../../boxes/author-note/contract";
import { initialWorldClockSetup, worldClockRecord, worldClockSetup } from "../../boxes/world-clock/contract";
import { MAX_PHONE_MOVES, phoneMove } from "../../boxes/phone/contract";
import { initialRaceSetup } from "../../boxes/race/shared-data";
import { MAX_RACE_MOVES, raceMoveLabel } from "../../boxes/race/shared";
import { phoneInstructions, phoneMoveLabel } from "../../boxes/phone/shared";
import { thoughtInstructions } from "../../boxes/thought/shared";
import { moodRecord } from "../../boxes/mood/shared";
import { decisionSelection } from "./decision-model";
import { memoryRecord } from "../../boxes/memory/contract";
import { numericWire } from "./wire";
import type { PromptOutgoingRole } from "./prompt-preset";

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
export type BoxDescriptor = {
	readonly label: string;
	readonly role: PromptOutgoingRole;
	readonly startsEnabled: boolean;
	readonly instructions: string;
	readonly alwaysRender?: true;
	readonly block?: { readonly description: string; readonly source: string };
	readonly setup?: { readonly schema: TSchema; readonly initial: BoxValue };
	readonly record?: TObject;
	readonly moves?: { readonly schema: TSchema; readonly max: number; label(move: never): string; readonly seatBound?: true };
	readonly decision?: { readonly summary: string; readonly description: string; readonly off: string; readonly context: string };
};
const setupOf = <Schema extends TSchema>(schema: Schema, initial: Static<Schema> & BoxValue) => ({ schema, initial });
const movesOf = <Schema extends TSchema>(schema: Schema, max: number, label: (move: Static<Schema>) => string) => ({ schema, max, label });

// @approved
//  What the host shows, defaults and stores for each Box: its preset block
// label, the role its block starts with, and whether a new Chat starts with
// it enabled. `instructions` is the text a new block starts with, after which
// it belongs to the preset; the block renders it before the Box's items, and
// renders nothing without items unless the Box declares `alwaysRender`.
// `block` is how the preset editor describes the block, in place of its
// generic copy. `setup` is its Conversation-scoped setup, which the
// set-box-setup command accepts. `record` is the schema of the record each
// Variant holds for it, which Writer overrides accept. `moves` are the Moves
// the human attaches to a Message, each shown as its chip `label`; seat-bound
// Moves are dropped from the composer when the human seat changes. A record is
// an object, so an absent record is never confused with a record's value. `decision`
// gives the Box a global Decision Model selection, which its digests ask, and
// the settings copy that selection shows. The registry is keyed by Box id, in
// the order the host lists and runs Boxes.
export const boxDescriptors: ReadonlyMap<BoxId, BoxDescriptor> = new Map(Object.entries({
	"author-note": {
		label: "Author Note", role: "system", startsEnabled: true, instructions: "",
		block: { description: "Uses the Author Note saved in this Chat. Edit its text in the Author Note panel.", source: "This Chat" },
		setup: setupOf(authorNoteSetup, ""),
	},
	memory: {
		label: "Memory", role: "system", startsEnabled: true, instructions: "",
		block: { description: "Uses Conversation Memories recalled when a Generation is assembled.", source: "Conversation Memories" },
		record: memoryRecord,
		decision: {
			summary: "Judges the Memories extraction proposes and scores saved Memories for recall.",
			description: "Choose a Decision Model to judge each Message's proposed Memories and to pick the ones a scene needs. Without one, Memory remembers and recalls nothing.",
			off: "Memory remembers nothing",
			context: "Each Message is read with up to four Messages before it.",
		},
	},
	"world-clock": {
		label: "World Clock", role: "system", startsEnabled: false, instructions: "",
		setup: setupOf(worldClockSetup, initialWorldClockSetup),
		record: worldClockRecord,
		decision: {
			summary: "Reads how much time passes and the weather in each passage.",
			description: "Choose a Decision Model to advance each Chat's World Clock from what its passages say. Without one, the clock stays where it is.",
			off: "The clock stays where it is",
			context: "Each passage is read with the Message before it.",
		},
	},
	race: {
		label: "Race", role: "system", startsEnabled: false, instructions: "",
		setup: setupOf(raceSetup, initialRaceSetup),
		record: raceRecord,
		moves: movesOf(raceMove, MAX_RACE_MOVES, raceMoveLabel),
	},
	phone: { label: "Phone", role: "system", startsEnabled: false, instructions: phoneInstructions, moves: { ...movesOf(phoneMove, MAX_PHONE_MOVES, phoneMoveLabel), seatBound: true } },
	thought: { label: "Thoughts", role: "system", startsEnabled: false, instructions: thoughtInstructions, alwaysRender: true },
	mood: {
		label: "Mood", role: "system", startsEnabled: false, instructions: "Scene mood:",
		record: moodRecord,
		decision: {
			summary: "Reads the mood each passage leaves the scene in.",
			description: "Choose a Decision Model to follow each Chat's mood from what its passages say. Without one, the mood stays where it is.",
			off: "The mood stays where it is",
			context: "Each passage is read with the Message before it.",
		},
	},
} satisfies Readonly<Record<BoxId, BoxDescriptor>>));

/** @approved The registered Box `id`'s descriptor. An unknown id throws, so a boundary checks ids before the host looks one up. */
export const boxDescriptor = (id: BoxId): BoxDescriptor => {
	const descriptor = boxDescriptors.get(id);
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
	reference.startsWith("box:") && boxDescriptors.has(reference.slice("box:".length));
/** @approved Whether `reference` has the `box:<id>` form but names no registered Box, which a preset refuses. */
export const isUnknownBoxReference = (reference: string): boolean => reference.startsWith("box:") && !isBoxReference(reference);
/** @approved The descriptor behind a Box's preset block reference. */
export const boxDescriptorOf = (reference: PromptBoxReference): BoxDescriptor => boxDescriptor(reference.slice("box:".length));
/** @approved Whether `id` is a registered digesting Box, the only kind with a Decision Model selection and a passage timeline. */
export const isDigestBox = (id: BoxId): boolean => boxDescriptors.get(id)?.decision !== undefined;
/** @approved Each registered Box whose descriptor declares `key`, in registry order, with that key's value. */
export const boxesWith = <Key extends keyof BoxDescriptor>(key: Key): [BoxId, NonNullable<BoxDescriptor[Key]>][] =>
	[...boxDescriptors].flatMap(([id, descriptor]) => {
		const value = descriptor[key];
		return value === undefined ? [] : [[id, value]];
	});
/** @approved A new Chat starts with these Boxes enabled and every other Box absent. */
export const defaultBoxIds = [...boxDescriptors].flatMap(([id, { startsEnabled }]) => startsEnabled ? [id] : []);

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

export const boxParams = Type.Object({ box: Type.String() });
export const conversationBoxParams = Type.Object({ id: numericWire, box: Type.String() });

export const boxDecisionSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer() })]);
export type BoxDecisionSettings = Static<typeof boxDecisionSettings>;
export const boxDecisionSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: boxDecisionSettings });
export const boxDecisionSettingsConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: boxDecisionSettings });
export const boxDecisionSettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const boxDecisionSettingsCommandErrors = Type.Union([boxDecisionSettingsConflict, boxDecisionSettingsInvalid]);
export const boxDecisionSettingsCommandBody = Type.Composite([decisionSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type BoxDecisionSettingsCommand = Static<typeof boxDecisionSettingsCommandBody>;
