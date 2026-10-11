import { raceSetup } from "./race";
import { Type, type Static, type TLiteral } from "@sinclair/typebox";
import { decisionSelection } from "./decision-model";
import { numericWire } from "./wire";

// @approved
//  Every compiled-in Box (ADR-0050). A Box's preset reference and its data
// namespace are both `box:<id>`.
export const boxIds = ["author-note", "memory", "world-clock", "race", "phone"] as const;
export type BoxId = typeof boxIds[number];
type LiteralSchemas<Values extends readonly string[]> = { -readonly [K in keyof Values]: TLiteral<Values[K]> };
// SAFETY: mapping each tuple value to its literal schema preserves its position and value type.
const boxIdSchemas = boxIds.map((id) => Type.Literal(id)) as LiteralSchemas<typeof boxIds>;
export const boxId = Type.Union(boxIdSchemas);

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
/** @approved A new Chat starts with these Boxes enabled and every other Box absent. */
export const defaultBoxIds = ["author-note", "memory"] as const satisfies readonly BoxId[];

export const worldClockStartPattern = "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d$";

export const worldClockSetup = Type.Object({
	/** @approved In-world start as a naive Gregorian `YYYY-MM-DDTHH:mm`. */
	start: Type.String({ pattern: worldClockStartPattern }),
	era: Type.String({ maxLength: 16 }),
	climate: Type.Union([Type.Literal("temperate"), Type.Literal("tropical"), Type.Literal("arid"), Type.Literal("cold")]),
	hemisphere: Type.Union([Type.Literal("north"), Type.Literal("south")]),
	unit: Type.Union([Type.Literal("C"), Type.Literal("F")]),
});
export type WorldClockSetup = Static<typeof worldClockSetup>;

/** @approved The setup pattern bounds every field; this rejects calendar dates that pattern alone rolls over, such as February 31. */
export const isWorldClockStart = (start: string): boolean => {
	if (!new RegExp(worldClockStartPattern).test(start)) return false;
	const at = new Date(`${start}:00Z`);
	return !Number.isNaN(at.getTime())
		&& at.getUTCFullYear() === Number(start.slice(0, 4))
		&& at.getUTCMonth() === Number(start.slice(5, 7)) - 1
		&& at.getUTCDate() === Number(start.slice(8, 10));
};

export const weathers = ["clear", "cloudy", "rain", "storm", "snow", "fog"] as const;
export type Weather = typeof weathers[number];

// SAFETY: mapping each tuple value to its literal schema preserves its position and value type.
const weatherSchemas = weathers.map((kind) => Type.Literal(kind)) as LiteralSchemas<typeof weathers>;

// @approved
//  A World Clock record holds facts about one passage: how many minutes it
// spans and the weather it establishes, if any.
export const worldClockRecord = Type.Object({
	minutes: Type.Integer({ minimum: 0 }),
	weather: Type.Union([...weatherSchemas, Type.Null()]),
});
export type WorldClockRecord = Static<typeof worldClockRecord>;

// @approved
//  Elapsed-time bins the Decision Model chooses from, with the inclusive
//  minute range an automatic digest draws its exact duration from and the
//  label the window's Editor offers. A Writer override names the bin and
//  stores its midpoint, a value inside the range the digest draws from.
export const elapsedBins = {
	none: { minutes: [0, 0], label: "No time passes" },
	"~5m": { minutes: [3, 8], label: "About 5 minutes" },
	"~15m": { minutes: [10, 20], label: "About 15 minutes" },
	"~30m": { minutes: [25, 40], label: "About 30 minutes" },
	"~1h": { minutes: [45, 80], label: "About 1 hour" },
	"~2h": { minutes: [90, 150], label: "About 2 hours" },
	"~4h": { minutes: [180, 300], label: "About 4 hours" },
	"~8h": { minutes: [360, 540], label: "About 8 hours" },
	overnight: { minutes: [540, 720], label: "Overnight" },
	"~1 day": { minutes: [1200, 1680], label: "About 1 day" },
	"several days": { minutes: [2880, 7200], label: "Several days" },
} as const satisfies Record<string, { readonly minutes: readonly [number, number]; readonly label: string }>;
export type ElapsedBin = keyof typeof elapsedBins;
export const elapsedBinNames = /* @approved SAFETY: Object.keys of the literal table returns exactly its keys. */ Object.keys(elapsedBins) as ElapsedBin[];
/** @approved Every stored duration is drawn inside a bin or set to one's midpoint, so an override always names a minute count the digest vocabulary represents. */
export const elapsedBinMinutes = (bin: ElapsedBin): number => {
	const [low, high] = elapsedBins[bin].minutes;
	return low + Math.floor((high - low) / 2);
};

// @approved
//  One Box record slot per Variant. `source` hashes the digested text, so an
// edit is digested again and a reselection is not.
export const worldClockRecordSlot = Type.Object({
	automatic: Type.Optional(worldClockRecord),
	writer: Type.Optional(worldClockRecord),
	source: Type.Optional(Type.String()),
});
export type WorldClockRecordSlot = Static<typeof worldClockRecordSlot>;

// @approved
//  One selected passage in the World Clock window, with its resolved record
//  (`writer ?? automatic`) and whether a writer set it. A null record means
//  the passage has not been digested. `digested` reports whether the
//  automatic result is the one for exactly this text, so the window knows
//  what a catch-up run would add.
export const worldClockPassage = Type.Object({
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	author: Type.Union([Type.Null(), Type.String()]),
	content: Type.String(),
	record: Type.Union([Type.Null(), worldClockRecord]),
	overridden: Type.Boolean(),
	digested: Type.Boolean(),
});
export type WorldClockPassage = Static<typeof worldClockPassage>;

// @approved
//  A catch-up run's window progress: how many passages it set out to digest
//  and how many are still queued or in flight.
export const boxCatchUp = Type.Object({
	total: Type.Integer({ minimum: 0 }),
	remaining: Type.Integer({ minimum: 0 }),
});
export type BoxCatchUp = Static<typeof boxCatchUp>;

// @approved
//  The World Clock window read: the folded clock's one-line status and the
//  selected path's passages. The dock and the window share this read.
//  `digestReady` reports whether a global Decision Model is selected, so the
//  window can explain why catch-up and pending reads cannot run.
export const worldClockRead = Type.Object({
	conversationId: Type.Integer(),
	revision: Type.Integer(),
	status: Type.Union([Type.Null(), Type.String()]),
	digestReady: Type.Boolean(),
	catchUp: Type.Union([Type.Null(), boxCatchUp]),
	passages: Type.Array(worldClockPassage),
});
export type WorldClockRead = Static<typeof worldClockRead>;

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
export const boxSetups = Type.Object({ "author-note": Type.String(), "world-clock": worldClockSetup, race: raceSetup });
export type BoxSetups = Static<typeof boxSetups>;

// @approved
//  The Boxes that digest passages in the background, each with its own
// global Decision Model selection in library_data.
export const digestBoxId = Type.Literal("world-clock");
export type DigestBoxId = Static<typeof digestBoxId>;
export const digestBoxParams = Type.Object({ box: digestBoxId });
export const boxWindowParams = Type.Object({ id: numericWire, box: digestBoxId });

export const boxDecisionSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer() })]);
export type BoxDecisionSettings = Static<typeof boxDecisionSettings>;
export const boxDecisionSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: boxDecisionSettings });
export const boxDecisionSettingsConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: boxDecisionSettings });
export const boxDecisionSettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const boxDecisionSettingsCommandErrors = Type.Union([boxDecisionSettingsConflict, boxDecisionSettingsInvalid]);
export const boxDecisionSettingsCommandBody = Type.Composite([decisionSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type BoxDecisionSettingsCommand = Static<typeof boxDecisionSettingsCommandBody>;
