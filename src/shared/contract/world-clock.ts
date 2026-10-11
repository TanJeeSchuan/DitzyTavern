import { Type, type Static, type TLiteral } from "@sinclair/typebox";

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
export const initialWorldClockSetup: WorldClockSetup = { start: "2025-06-01T08:00", era: "AD", climate: "temperate", hemisphere: "north", unit: "C" };

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

/** @approved Each weather's label, as the passage timeline offers and shows it. */
export const weatherLabels = {
	clear: "☀️ Clear",
	cloudy: "☁️ Cloudy",
	rain: "🌧️ Rain",
	storm: "⛈️ Storm",
	snow: "🌨️ Snow",
	fog: "🌫️ Fog",
} as const satisfies Record<Weather, string>;

type LiteralSchemas<Values extends readonly string[]> = { -readonly [K in keyof Values]: TLiteral<Values[K]> };
// SAFETY: mapping each tuple value to its literal schema preserves its position and value type.
const weatherSchemas = weathers.map((kind) => Type.Literal(kind, { title: weatherLabels[kind] })) as LiteralSchemas<typeof weathers>;

// @approved
//  A World Clock record holds facts about one passage: how many minutes it
// spans and the weather it establishes, if any. The titles label the passage
// timeline's Writer override fields.
export const worldClockRecord = Type.Object({
	minutes: Type.Integer({ minimum: 0, title: "Minutes" }),
	weather: Type.Union([...weatherSchemas, Type.Null({ title: "Not mentioned" })], { title: "Weather" }),
});
export type WorldClockRecord = Static<typeof worldClockRecord>;
