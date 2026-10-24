import type { RaceCourse, RaceRunner, RaceSetup, RaceStats, RunningStyle } from "./contract";

export const raceCourses: readonly RaceCourse[] = [
	{ name: "Japan Cup · Tokyo", distance: 2400, surface: "turf", direction: "left" },
	{ name: "Arima Kinen · Nakayama", distance: 2500, surface: "turf", direction: "right" },
	{ name: "Tokyo Yushun · Tokyo", distance: 2400, surface: "turf", direction: "left" },
	{ name: "Tenno Sho (Spring) · Kyoto", distance: 3200, surface: "turf", direction: "right" },
	{ name: "Takarazuka Kinen · Hanshin", distance: 2200, surface: "turf", direction: "right" },
	{ name: "Yasuda Kinen · Tokyo", distance: 1600, surface: "turf", direction: "left" },
	{ name: "Sprinters Stakes · Nakayama", distance: 1200, surface: "turf", direction: "right" },
	{ name: "Champions Cup · Chukyo", distance: 1800, surface: "dirt", direction: "left" },
];
export const raceRoster: readonly { name: string; style: RunningStyle }[] = [
	{ name: "Special Week", style: "Late Surger" },
	{ name: "Silence Suzuka", style: "Front Runner" },
	{ name: "Tokai Teio", style: "Pace Chaser" },
	{ name: "Gold Ship", style: "End Closer" },
	{ name: "Mejiro McQueen", style: "Pace Chaser" },
	{ name: "Vodka", style: "Late Surger" },
	{ name: "Daiwa Scarlet", style: "Front Runner" },
	{ name: "Oguri Cap", style: "Pace Chaser" },
	{ name: "Grass Wonder", style: "Late Surger" },
	{ name: "El Condor Pasa", style: "Pace Chaser" },
	{ name: "Rice Shower", style: "Pace Chaser" },
	{ name: "Haru Urara", style: "End Closer" },
	{ name: "Sakura Bakushin O", style: "Front Runner" },
	{ name: "Narita Brian", style: "Late Surger" },
	{ name: "Symboli Rudolf", style: "Pace Chaser" },
	{ name: "Tamamo Cross", style: "End Closer" },
	{ name: "Seiun Sky", style: "Front Runner" },
	{ name: "King Halo", style: "Late Surger" },
];

/** @approved A roster Runner's avatar is Race library data under this key, holding the bare Image hash so the orphan sweep keeps it. */
export const RACE_AVATAR_PREFIX = "avatar:";

export const initialRaceSetup: RaceSetup = {
	raceId: "", course: raceCourses[0]!, metresPerStretch: 400, slots: [], auto: "on", phase: "setup",
};

export const raceRandom = (seed: string): (() => number) => {
	let value = 2166136261;
	for (let i = 0; i < seed.length; i++) value = Math.imul(value ^ seed.charCodeAt(i), 16777619);
	return () => {
		value += 0x6D2B79F5;
		let next = Math.imul(value ^ value >>> 15, 1 | value);
		next ^= next + Math.imul(next ^ next >>> 7, 61 | next);
		return ((next ^ next >>> 14) >>> 0) / 4294967296;
	};
};

/** @approved One seeded stat roll biased toward the Running style; the roster draw and the stat sheet share it, so a style always rolls the same way. */
export function rollRaceStats(style: RunningStyle, random: () => number): RaceStats {
	const roll = (bonus = 0) => Math.round(450 + random() * 300 + bonus);
	return { style, speed: roll(style === "Front Runner" ? 100 : 0), stamina: roll(style === "Pace Chaser" ? 100 : 0),
		power: roll(style === "Late Surger" ? 100 : 0), guts: roll(style === "End Closer" ? 100 : 0), wit: roll() };
}

export function fillRaceField(slots: readonly RaceRunner[], excludedNames: readonly string[], seed: string, size = 8): RaceRunner[] {
	const random = raceRandom(seed);
	const used = new Set([...slots.map((runner) => runner.name), ...excludedNames].map((name) => name.trim().toLowerCase()));
	const available = raceRoster.filter((runner) => !used.has(runner.name.toLowerCase()))
		.map((runner) => ({ runner, draw: random() })).sort((a, b) => a.draw - b.draw);
	return [...slots, ...available.slice(0, Math.max(0, size - slots.length)).map(({ runner }) => ({ ...runner, ...rollRaceStats(runner.style, random) }))];
}

/** @approved Adds a Cast Runner to the field, replacing a roster Runner of the same name (trimmed, case-insensitive, as the setup validator compares) so one name never occupies two gates. */
export const addRaceRunner = (slots: readonly RaceRunner[], runner: RaceRunner): RaceRunner[] =>
	[...slots.filter((slot) => slot.participantId !== runner.participantId
		&& !(slot.participantId === undefined && slot.name.trim().toLowerCase() === runner.name.trim().toLowerCase())), runner];
