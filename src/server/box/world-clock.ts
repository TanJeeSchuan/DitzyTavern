import { elapsedBinNames, elapsedBins, weathers, worldClockRecord, worldClockSetup, type ElapsedBin, type Weather, type WorldClockRecord, type WorldClockSetup } from "../../shared/contract/box";
import type { DecisionAnswer } from "../../shared/contract/decision-model";
import type { Box } from "./contract";
import { seededFraction } from "./seed";

// @approved
//  What each elapsed bin means to the Decision Model. The minute ranges an
//  automatic digest draws from live in the shared contract, because the
//  window's Writer Editor offers the same bins as an override.
const elapsedCriteria = {
	none: "No time passes beyond the conversation itself",
	"~5m": "A brief exchange or a few actions",
	"~15m": "A short scene or a walk across a building",
	"~30m": "A meal, a short trip, or a long talk",
	"~1h": "About an hour of activity",
	"~2h": "A couple of hours",
	"~4h": "An afternoon, or a long journey",
	"~8h": "A working day, or most of a day",
	overnight: "The characters sleep or the night passes",
	"~1 day": "About a day passes",
	"several days": "Days pass, as in a time skip",
} as const satisfies Record<ElapsedBin, string>;

const weatherKinds = {
	clear: { label: "Clear", icon: "☀️", offset: 0, criteria: "Clear or sunny sky" },
	cloudy: { label: "Cloudy", icon: "☁️", offset: -1, criteria: "Clouds or overcast sky" },
	rain: { label: "Rain", icon: "🌧️", offset: -2, criteria: "Rain or drizzle" },
	storm: { label: "Storm", icon: "⛈️", offset: -3, criteria: "Thunderstorm or heavy storm" },
	snow: { label: "Snow", icon: "🌨️", offset: -3, criteria: "Snow or sleet" },
	fog: { label: "Fog", icon: "🌫️", offset: -1, criteria: "Fog or mist" },
} as const satisfies Record<Weather, { label: string; icon: string; offset: number; criteria: string }>;

const NOT_MENTIONED = "not mentioned";
const WEATHER_MEMORY_MINUTES = 24 * 60;

export const drawMinutes = (bin: ElapsedBin, seed: string): number => {
	const [low, high] = elapsedBins[bin].minutes;
	return low + Math.floor(seededFraction(seed) * (high - low + 1));
};


// @approved
//  Minutes since the setup's start, and the latest weather established with
// the minute it was last mentioned.
export interface WorldClockState {
	readonly minutes: number;
	readonly weather: { readonly kind: Weather; readonly at: number } | null;
}

const climateCurves = {
	temperate: { mean: 11, seasonal: 9, diurnal: 5 },
	tropical: { mean: 27, seasonal: 2, diurnal: 4 },
	arid: { mean: 22, seasonal: 10, diurnal: 8 },
	cold: { mean: -2, seasonal: 14, diurnal: 4 },
} as const satisfies Record<WorldClockSetup["climate"], { mean: number; seasonal: number; diurnal: number }>;

// @approved
//  The coldest day falls in mid-January (mid-July south of the equator), the
// coldest hour at 3 AM. Snow never sits above freezing.
export const temperature = (setup: Pick<WorldClockSetup, "climate" | "hemisphere">, at: Date, weather: Weather): number => {
	const curve = climateCurves[setup.climate];
	const dayOfYear = (at.getTime() - Date.UTC(at.getUTCFullYear(), 0, 1)) / 86_400_000;
	const season = -Math.cos(2 * Math.PI * (dayOfYear - 15 + (setup.hemisphere === "south" ? 182 : 0)) / 365);
	const day = -Math.cos(2 * Math.PI * (at.getUTCHours() + at.getUTCMinutes() / 60 - 3) / 24);
	const celsius = curve.mean + curve.seasonal * season + curve.diurnal * day + weatherKinds[weather].offset;
	return Math.round(weather === "snow" ? Math.min(celsius, 0) : celsius);
};

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// @approved
//  The start is a naive Gregorian time; UTC arithmetic keeps it free of the
// server's time zone and daylight saving.
export const clockAt = (setup: WorldClockSetup, minutes: number): Date => new Date(Date.parse(`${setup.start}:00Z`) + minutes * 60_000);

// @approved
//  One reading of the clock; the prompt line and the dock status present the
//  same time, date and weather without recomputing any of them twice.
const clockReading = (setup: WorldClockSetup, state: WorldClockState) => {
	const at = clockAt(setup, state.minutes);
	const hour = at.getUTCHours();
	const time = `${hour % 12 || 12}:${String(at.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
	const era = setup.era.trim() === "" ? "" : ` ${setup.era.trim()}`;
	const date = `🗓️ ${weekdays[at.getUTCDay()]}, ${months[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}${era}`;
	const weather = state.weather !== null && state.minutes - state.weather.at < WEATHER_MEMORY_MINUTES ? state.weather.kind : null;
	if (weather === null) return { time, date, weather: null };
	const celsius = temperature(setup, at, weather);
	const degrees = setup.unit === "C" ? `${celsius}°C` : `${Math.round(celsius * 9 / 5 + 32)}°F`;
	const icon = weather === "clear" && (hour < 6 || hour >= 19) ? "🌙" : weatherKinds[weather].icon;
	return { time, date, weather: { icon, label: weatherKinds[weather].label, degrees } };
};

export const clockLine = (setup: WorldClockSetup, state: WorldClockState): string => {
	const { time, date, weather } = clockReading(setup, state);
	return `${time} | ${date}${weather === null ? "" : ` | ${weather.icon} ${weather.label}, ${weather.degrees}`}`;
};

/** @approved The dock's one-line status: time and weather, without the date. */
export const clockStatus = (setup: WorldClockSetup, state: WorldClockState): string => {
	const { time, weather } = clockReading(setup, state);
	return `${time}${weather === null ? "" : ` · ${weather.icon} ${weather.degrees}`}`;
};

const choiceOf = <Option extends string>(answer: DecisionAnswer | undefined, options: readonly Option[]): Option => {
	const choice = answer?.type === "choice" ? options.find((option) => option === answer.choice) : undefined;
	if (choice === undefined) throw new Error("The Decision Model returned no World Clock choice.");
	return choice;
};

export const worldClockBox = {
	setup: {
		schema: worldClockSetup,
		initial: { enabled: false, start: "2025-06-01T08:00", era: "AD", climate: "temperate", hemisphere: "north", unit: "C" },
	},
	records: {
		schema: worldClockRecord,
		initial: { minutes: 0, weather: null },
		fold: (state, record) => {
			const minutes = state.minutes + record.minutes;
			return { minutes, weather: record.weather === null ? state.weather : { kind: record.weather, at: minutes } };
		},
		digest: {
			window: 1,
			run: async ({ passage, preceding, seed }, ctx) => {
				const answers = await ctx.decide({ passage, preceding }, {
					elapsed: {
						type: "choice",
						instructions: { question: "How much in-world time passes during `passage`?" },
						criteria: Object.fromEntries(elapsedBinNames.map((bin) => [bin, elapsedCriteria[bin]])),
					},
					weather: {
						type: "choice",
						instructions: { question: "What weather does `passage` establish?" },
						criteria: { [NOT_MENTIONED]: "`passage` does not mention the weather", ...Object.fromEntries(Object.entries(weatherKinds).map(([kind, { criteria }]) => [kind, criteria])) },
					},
				});
				const bin = choiceOf(answers.get("elapsed"), elapsedBinNames);
				const weather = choiceOf(answers.get("weather"), [NOT_MENTIONED, ...weathers]);
				return { minutes: drawMinutes(bin, seed), weather: weather === NOT_MENTIONED ? null : weather };
			},
		},
	},
	advance: { run: async ({ setup, state }) => ({ items: [{ text: clockLine(setup, state), priority: 0, pinned: true }] }) },
	status: clockStatus,
} satisfies Box<WorldClockSetup, undefined, never, never, WorldClockRecord, WorldClockState>;
