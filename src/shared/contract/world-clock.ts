import { Type, type Static, type TLiteral } from "@sinclair/typebox";
import { digestRead, type DigestRead } from "./box-digest";

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

export const worldClockRead = digestRead(worldClockRecord);
export type WorldClockRead = DigestRead<typeof worldClockRecord>;
export type WorldClockPassage = WorldClockRead["passages"][number];
