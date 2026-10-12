import { raceMove, raceRecord, raceSetup } from "../../boxes/race/contract";
import { Kind, Type, type Static, type TLiteral, type TObject, type TSchema } from "@sinclair/typebox";
import { initialWorldClockSetup, worldClockRecord, worldClockSetup } from "../../boxes/world-clock/contract";
import { MAX_PHONE_MOVES, phoneMove } from "../../boxes/phone/contract";
import { initialRaceSetup } from "../../boxes/race/shared-data";
import { MAX_RACE_MOVES, raceMoveLabel } from "../../boxes/race/shared";
import { phoneMoveLabel } from "../../boxes/phone/shared";
import { moodRecord } from "../../boxes/mood/shared";
import type { GenerationJsonValue } from "../generation-json";
import { decisionSelection } from "./decision-model";
import { numericWire } from "./wire";
import type { PromptOutgoingRole } from "./prompt-preset";

// @approved
//  Every compiled-in Box (ADR-0050). A Box's preset reference and its data
// namespace are both `box:<id>`.
export const boxIds = ["author-note", "memory", "world-clock", "race", "phone", "thought", "mood"] as const;
export type BoxId = typeof boxIds[number];
/** @approved Mapped over a tuple, so Elysia's route types resolve each member. */
type LiteralSchemas<Values extends readonly string[]> = { -readonly [K in keyof Values]: TLiteral<Values[K]> };
// SAFETY: mapping each tuple value to its literal schema preserves its position and value type.
const literals = <Values extends readonly string[]>(values: Values) => values.map((value) => Type.Literal(value)) as LiteralSchemas<Values>;
export const boxId = Type.Union(literals(boxIds));

export const promptBoxReference = Type.TemplateLiteral([Type.Literal("box:"), boxId]);
export type PromptBoxReference = Static<typeof promptBoxReference>;
export const boxReference = (id: BoxId): PromptBoxReference => `box:${id}`;
export const isBoxReference = (reference: string): reference is PromptBoxReference =>
	boxIds.some((id) => boxReference(id) === reference);

// @approved
//  A Box's lifecycle in one Chat. Only an enabled Box runs; a disabled one
// keeps its Chat-scoped data; an absent one has none.
export const boxState = Type.Union([Type.Literal("enabled"), Type.Literal("disabled"), Type.Literal("absent")]);
export type BoxState = Static<typeof boxState>;
export const boxStates = Type.Record(boxId, boxState);
export type BoxStates = Static<typeof boxStates>;
type BoxDescriptor = {
	readonly label: string;
	readonly role: PromptOutgoingRole;
	readonly startsEnabled: boolean;
	readonly setup?: { readonly schema: TSchema; readonly initial: unknown };
	readonly record?: TObject;
	readonly moves?: { readonly schema: TSchema; readonly max: number; label(move: never): string; readonly seatBound?: true };
	readonly decision?: { readonly summary: string; readonly description: string; readonly off: string; readonly context: string };
};
const setupOf = <Schema extends TSchema>(schema: Schema, initial: Static<Schema>) => ({ schema, initial });
const movesOf = <Schema extends TSchema>(schema: Schema, max: number, label: (move: Static<Schema>) => string) => ({ schema, max, label });

// @approved
//  What the host shows, defaults and stores for each Box: its preset block
// label, the role its block starts with, and whether a new Chat starts with
// it enabled. `setup` is its Conversation-scoped setup, which the
// set-box-setup command accepts. `record` is the schema of the record each
// Variant holds for it, which Writer overrides accept. `moves` are the Moves
// the human attaches to a Message, each shown as its chip `label`; seat-bound
// Moves are dropped from the composer when the human seat changes. A record is
// an object, so an absent record is never confused with a record's value. `decision`
// gives the Box a global Decision Model selection, which its digests ask, and
// the settings copy that selection shows.
export const boxDescriptors = {
	"author-note": { label: "Author Note", role: "system", startsEnabled: true, setup: setupOf(Type.String(), "") },
	memory: { label: "Memory", role: "system", startsEnabled: true },
	"world-clock": {
		label: "World Clock", role: "system", startsEnabled: false,
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
		label: "Race", role: "system", startsEnabled: false,
		setup: setupOf(raceSetup, initialRaceSetup),
		record: raceRecord,
		moves: movesOf(raceMove, MAX_RACE_MOVES, raceMoveLabel),
	},
	phone: { label: "Phone", role: "system", startsEnabled: false, moves: { ...movesOf(phoneMove, MAX_PHONE_MOVES, phoneMoveLabel), seatBound: true } },
	thought: { label: "Thoughts", role: "system", startsEnabled: false },
	mood: {
		label: "Mood", role: "system", startsEnabled: false,
		record: moodRecord,
		decision: {
			summary: "Reads the mood each passage leaves the scene in.",
			description: "Choose a Decision Model to follow each Chat's mood from what its passages say. Without one, the mood stays where it is.",
			off: "The mood stays where it is",
			context: "Each passage is read with the Message before it.",
		},
	},
} as const satisfies Record<BoxId, BoxDescriptor>;
export type BoxDescriptors = typeof boxDescriptors;
/** @approved A new Chat starts with these Boxes enabled and every other Box absent. */
export const defaultBoxIds = boxIds.filter((id) => boxDescriptors[id].startsEnabled);

type BoxIdsWith<Ids extends readonly BoxId[], Hook extends string> = Ids extends readonly [infer Id extends BoxId, ...infer Rest extends readonly BoxId[]]
	? Hook extends keyof BoxDescriptors[Id] ? [Id, ...BoxIdsWith<Rest, Hook>] : BoxIdsWith<Rest, Hook>
	: [];
// SAFETY: filtering keeps the order of boxIds, which the tuple type follows.
const boxIdsWith = <Hook extends string>(hook: Hook) => boxIds.filter((id) => hook in boxDescriptors[id]) as BoxIdsWith<typeof boxIds, Hook>;
export const setupBoxIds = boxIdsWith("setup");
export type SetupBoxId = typeof setupBoxIds[number];
export const recordBoxIds = boxIdsWith("record");
export type RecordBoxId = typeof recordBoxIds[number];
export const moveBoxIds = boxIdsWith("moves");
export type MoveBoxId = typeof moveBoxIds[number];
export const digestBoxIds = boxIdsWith("decision");
export type DigestBoxId = typeof digestBoxIds[number];
export const isDigestBoxId = (id: BoxId): id is DigestBoxId => digestBoxIds.some((digest) => digest === id);

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
//  Each Box's Conversation-scoped setup, as the Chat summary carries it and
// the set-box-setup command writes it. The Author Note's setup is its text,
// Image References included.
// SAFETY: the entries are exactly the setup Boxes, each with its own schema.
const setupSchemas = Object.fromEntries(setupBoxIds.map((id) => [id, boxDescriptors[id].setup.schema])) as { [Id in SetupBoxId]: BoxDescriptors[Id]["setup"]["schema"] };
export const boxSetups = Type.Object(setupSchemas);
export type BoxSetups = Static<typeof boxSetups>;

export const digestBoxId = Type.Union(literals(digestBoxIds));
export const recordBoxId = Type.Union(literals(recordBoxIds));
export const digestBoxParams = Type.Object({ box: digestBoxId });
export const boxWindowParams = Type.Object({ id: numericWire, box: digestBoxId });
export const boxReadParams = Type.Object({ id: numericWire, box: boxId });
/** @approved A Box window read; the client decodes it with that Box's own read schema. */
export const boxRead = Type.Unsafe<GenerationJsonValue>({ [Kind]: "Unknown" });

export const boxDecisionSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer() })]);
export type BoxDecisionSettings = Static<typeof boxDecisionSettings>;
export const boxDecisionSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: boxDecisionSettings });
export const boxDecisionSettingsConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: boxDecisionSettings });
export const boxDecisionSettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const boxDecisionSettingsCommandErrors = Type.Union([boxDecisionSettingsConflict, boxDecisionSettingsInvalid]);
export const boxDecisionSettingsCommandBody = Type.Composite([decisionSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type BoxDecisionSettingsCommand = Static<typeof boxDecisionSettingsCommandBody>;
