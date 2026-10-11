import { Type, type Static } from "@sinclair/typebox";
import { decisionSelection } from "./decision-model";

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

export const worldClockSetup = Type.Object({
	/** @approved In-world start as a naive Gregorian `YYYY-MM-DDTHH:mm`. */
	start: Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d$" }),
	era: Type.String({ maxLength: 16 }),
	climate: Type.Union([Type.Literal("temperate"), Type.Literal("tropical"), Type.Literal("arid"), Type.Literal("cold")]),
	hemisphere: Type.Union([Type.Literal("north"), Type.Literal("south")]),
	unit: Type.Union([Type.Literal("C"), Type.Literal("F")]),
});
export type WorldClockSetup = Static<typeof worldClockSetup>;

export const weathers = ["clear", "cloudy", "rain", "storm", "snow", "fog"] as const;
export type Weather = typeof weathers[number];

// @approved
//  A World Clock record holds facts about one passage: how many minutes it
// spans and the weather it establishes, if any.
export const worldClockRecord = Type.Object({
	minutes: Type.Integer({ minimum: 0 }),
	weather: Type.Union([...weathers.map((kind) => Type.Literal(kind)), Type.Null()]),
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

export const boxDecisionSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer() })]);
export type BoxDecisionSettings = Static<typeof boxDecisionSettings>;
export const boxDecisionSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: boxDecisionSettings });
export const boxDecisionSettingsConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: boxDecisionSettings });
export const boxDecisionSettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const boxDecisionSettingsCommandErrors = Type.Union([boxDecisionSettingsConflict, boxDecisionSettingsInvalid]);
export const boxDecisionSettingsCommandBody = Type.Composite([decisionSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type BoxDecisionSettingsCommand = Static<typeof boxDecisionSettingsCommandBody>;
