import { describe, expect, test } from "bun:test";
import { isWorldClockStart, type WorldClockRecord, type WorldClockSetup } from "./contract";
import { clockAt, clockLine, clockStatus, drawMinutes, temperature, worldClockBox } from "./server";

const setup: WorldClockSetup = { start: "2025-12-20T08:41", era: "AD", climate: "temperate", hemisphere: "north", unit: "C" };
const fold = (records: WorldClockRecord[]) => records.reduce(worldClockBox.records.fold, worldClockBox.records.initial);

describe("World Clock calendar", () => {
	test("rolls the weekday, month and year over midnight on New Year's Eve", () => {
		expect(clockLine({ ...setup, start: "2025-12-31T23:30" }, fold([{ minutes: 45, weather: null }])))
			.toBe("12:15 AM | 🗓️ Thursday, January 1, 2026 AD");
	});

	test("counts February 29 in a leap year and skips it otherwise", () => {
		expect(clockLine({ ...setup, start: "2024-02-28T12:00" }, fold([{ minutes: 24 * 60, weather: null }]))).toContain("Thursday, February 29, 2024");
		expect(clockLine({ ...setup, start: "2100-02-28T12:00" }, fold([{ minutes: 24 * 60, weather: null }]))).toContain("Monday, March 1, 2100");
	});

	test("keeps years before 100 as written", () => {
		expect(clockAt({ ...setup, start: "0044-03-15T09:00" }, 0).getUTCFullYear()).toBe(44);
	});
});

describe("World Clock weather", () => {
	test("shows weather established in the prose", () => {
		expect(clockLine(setup, fold([{ minutes: 0, weather: "clear" }]))).toBe("8:41 AM | 🗓️ Saturday, December 20, 2025 AD | ☀️ Clear, 3°C");
	});

	test("forgets weather 24 in-world hours after its last mention", () => {
		const mentioned = { minutes: 10, weather: "rain" } as const;
		expect(clockLine(setup, fold([mentioned, { minutes: 24 * 60 - 1, weather: null }]))).toContain("Rain");
		expect(clockLine(setup, fold([mentioned, { minutes: 24 * 60, weather: null }]))).not.toContain("Rain");
		expect(clockLine(setup, fold([mentioned, { minutes: 20 * 60, weather: "rain" }, { minutes: 20 * 60, weather: null }]))).toContain("Rain");
	});
});

describe("World Clock temperature", () => {
	const noon = (date: string) => new Date(`${date}T14:00:00Z`);

	test("follows the seasons, mirrored south of the equator", () => {
		const north = { climate: "temperate", hemisphere: "north" } as const;
		const south = { ...north, hemisphere: "south" } as const;
		expect(temperature(north, noon("2025-07-15"), "clear")).toBeGreaterThan(temperature(north, noon("2025-01-15"), "clear") + 10);
		expect(temperature(south, noon("2025-01-15"), "clear")).toBe(temperature(north, noon("2025-07-16"), "clear"));
	});

	test("keeps the season in years before 100", () => {
		const north = { climate: "temperate", hemisphere: "north" } as const;
		expect(temperature(north, noon("0044-01-15"), "clear")).toBe(temperature(north, noon("2025-01-15"), "clear"));
	});

	test("is warmer in the afternoon than before dawn", () => {
		const arid = { climate: "arid", hemisphere: "north" } as const;
		expect(temperature(arid, new Date("2025-04-01T15:00:00Z"), "clear") - temperature(arid, new Date("2025-04-01T03:00:00Z"), "clear")).toBe(16);
	});

	test("cools under storms and keeps snow at or below freezing", () => {
		const tropical = { climate: "tropical", hemisphere: "north" } as const;
		expect(temperature(tropical, noon("2025-06-01"), "storm")).toBe(temperature(tropical, noon("2025-06-01"), "clear") - 3);
		expect(temperature(tropical, noon("2025-06-01"), "snow")).toBe(0);
	});

	test("converts to Fahrenheit", () => {
		expect(clockLine({ ...setup, unit: "F" }, fold([{ minutes: 0, weather: "clear" }]))).toContain("☀️ Clear, 37°F");
	});
});

test("drawn minutes stay inside their bin and follow the seed", () => {
	const seeds = Array.from({ length: 200 }, (_, index) => `seed-${index}`);
	const minutes = seeds.map((seed) => drawMinutes("~30m", seed));
	expect(minutes.every((value) => value >= 25 && value <= 40)).toBe(true);
	expect(new Set(minutes)).toEqual(new Set(Array.from({ length: 16 }, (_, index) => 25 + index)));
	expect(drawMinutes("~30m", "seed-7")).toBe(minutes[7]!);
	expect(drawMinutes("none", "seed-7")).toBe(0);
});

test("the start rejects calendar dates the pattern alone rolls over", () => {
	expect(isWorldClockStart("2025-02-31T08:00")).toBe(false);
	expect(isWorldClockStart("2025-04-31T08:00")).toBe(false);
	expect(isWorldClockStart("2025-02-29T08:00")).toBe(false);
	expect(isWorldClockStart("2024-02-29T08:00")).toBe(true);
	expect(isWorldClockStart("2025-06-01T08:00")).toBe(true);
	expect(isWorldClockStart("not a date")).toBe(false);
});

test("the status keeps the time and drops the date", () => {
	expect(clockStatus(setup, fold([{ minutes: 0, weather: null }]))).toBe("8:41 AM");
	expect(clockStatus(setup, fold([{ minutes: 0, weather: "clear" }]))).toBe("8:41 AM · ☀️ 3°C");
});
