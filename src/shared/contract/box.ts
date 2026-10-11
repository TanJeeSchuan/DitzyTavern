import { Type, type Static, type TLiteral } from "@sinclair/typebox";
import { decisionSelection } from "./decision-model";
import { numericWire } from "./wire";

// @approved
//  Every compiled-in Box (ADR-0050). A Box's preset reference and its data
// namespace are both `box:<id>`.
export const boxIds = ["author-note", "memory", "world-clock"] as const;
export type BoxId = typeof boxIds[number];
export const boxId = Type.Union(boxIds.map((id) => Type.Literal(id)));

export const promptBoxReference = Type.TemplateLiteral([Type.Literal("box:"), boxId]);
export type PromptBoxReference = Static<typeof promptBoxReference>;
export const boxReference = (id: BoxId): PromptBoxReference => `box:${id}`;
export const isBoxReference = (reference: string): reference is PromptBoxReference =>
	boxIds.some((id) => boxReference(id) === reference);

export const worldClockStartPattern = "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d$";

export const worldClockSetup = Type.Object({
	/** @approved The Chat's World Clock toggle. Off by default: an off clock contributes no prompt item and queues no digest. */
	enabled: Type.Boolean(),
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

type LiteralSchemas<Values extends readonly string[]> = { -readonly [K in keyof Values]: TLiteral<Values[K]> };
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
//  the passage has not been digested.
export const worldClockPassage = Type.Object({
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	author: Type.Union([Type.Null(), Type.String()]),
	content: Type.String(),
	record: Type.Union([Type.Null(), worldClockRecord]),
	overridden: Type.Boolean(),
});
export type WorldClockPassage = Static<typeof worldClockPassage>;

// @approved
//  The World Clock window read: the folded clock's one-line status and the
//  selected path's passages. The dock and the window share this read.
export const worldClockRead = Type.Object({
	conversationId: Type.Integer(),
	revision: Type.Integer(),
	status: Type.Union([Type.Null(), Type.String()]),
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
export const boxSetups = Type.Object({ "author-note": Type.String(), "world-clock": worldClockSetup });
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
