import { Type, type Static } from "@sinclair/typebox";

export const runningStyle = Type.Union([Type.Literal("Front Runner"), Type.Literal("Pace Chaser"), Type.Literal("Late Surger"), Type.Literal("End Closer")]);
export type RunningStyle = Static<typeof runningStyle>;
export const raceCourse = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 100 }),
	distance: Type.Integer({ minimum: 400, maximum: 10000 }),
	surface: Type.Union([Type.Literal("turf"), Type.Literal("dirt")]),
	direction: Type.Union([Type.Literal("left"), Type.Literal("right")]),
});
export type RaceCourse = Static<typeof raceCourse>;
const stat = Type.Integer({ minimum: 1, maximum: 1200 });
export const raceRunner = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 100 }),
	style: runningStyle,
	speed: stat, stamina: stat, power: stat, guts: stat, wit: stat,
});
export type RaceRunner = Static<typeof raceRunner>;
export const raceSetup = Type.Object({
	raceId: Type.String(),
	course: raceCourse,
	metresPerStretch: Type.Integer({ minimum: 100, maximum: 2000 }),
	slots: Type.Array(raceRunner, { maxItems: 18 }),
	auto: Type.Union([Type.Literal("off"), Type.Literal("on"), Type.Object({ until: Type.Integer({ minimum: 0, maximum: 10000 }) })]),
	phase: Type.Union([Type.Literal("setup"), Type.Literal("running")]),
});
export type RaceSetup = Static<typeof raceSetup>;
export const raceStanding = Type.Object({
	name: Type.String(), distance: Type.Number(), energy: Type.Number(), time: Type.Number(),
});
export const raceState = Type.Object({
	raceId: Type.String(), stretch: Type.Integer(), metres: Type.Number(), finished: Type.Boolean(),
	standings: Type.Array(raceStanding),
});
export type RaceState = Static<typeof raceState>;
export const raceRecord = Type.Object({
	raceId: Type.String(), stretch: Type.Integer(), outcome: Type.String(), after: raceState,
});
export type RaceRecord = Static<typeof raceRecord>;
export const raceRecordSlot = Type.Object({ automatic: raceRecord });
export type RaceInput = { setup: RaceSetup; state: RaceState | null; seed: string; intent: "respond" | "continue" };
export const isRaceAutoValid = (setup: RaceSetup): boolean => setup.auto === "on" || setup.auto === "off" || setup.auto.until < setup.course.distance;
export const raceRead = Type.Object({
	conversationId: Type.Integer(), revision: Type.Integer(), status: Type.Union([Type.String(), Type.Null()]),
	state: raceState,
});
export type RaceRead = Static<typeof raceRead>;
