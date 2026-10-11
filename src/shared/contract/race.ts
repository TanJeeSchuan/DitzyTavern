import { Type, type Static } from "@sinclair/typebox";

export const runningStyles = ["Front Runner", "Pace Chaser", "Late Surger", "End Closer"] as const;
export type RunningStyle = typeof runningStyles[number];
export const runningStyle = Type.Unsafe<RunningStyle>(Type.Union(runningStyles.map((style) => Type.Literal(style))));
export const raceCourse = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 100 }),
	distance: Type.Integer({ minimum: 400, maximum: 10000 }),
	surface: Type.Union([Type.Literal("turf"), Type.Literal("dirt")]),
	direction: Type.Union([Type.Literal("left"), Type.Literal("right")]),
});
export type RaceCourse = Static<typeof raceCourse>;
const stat = Type.Integer({ minimum: 1, maximum: 1200 });
// @approved
//  A Runner's race stats, shared by Character data, Participant data, the
//  stat sheet and the setup slot it produces.
export const raceStats = Type.Object({
	style: runningStyle,
	speed: stat, stamina: stat, power: stat, guts: stat, wit: stat,
});
export type RaceStats = Static<typeof raceStats>;
// @approved
//  One Cast member's own Participant race stats, as the Race stat sheet reads
//  them. Participants without stats are simply absent.
export const raceCastStats = Type.Object({ participantId: Type.Integer(), stats: raceStats });
export type RaceCastStats = Static<typeof raceCastStats>;
export const raceRunner = Type.Composite([
	Type.Object({
		name: Type.String({ minLength: 1, maxLength: 100 }),
		// @approved The Participant this slot came from, if any; roster Runners leave it unset. It links the gate back to the Cast for Portrait, stat sheet and withdrawal.
		participantId: Type.Optional(Type.Integer()),
	}),
	raceStats,
]);
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
// @approved
//  A Race Move acts on one Runner: the human-seat Runner, or the Runner the
//  writer orders when the human seat is not racing.
export const raceMove = Type.Object({
	kind: Type.Union([Type.Literal("overtake"), Type.Literal("conserve"), Type.Literal("spurt"), Type.Literal("hold")]),
	runner: Type.String({ minLength: 1, maxLength: 100 }),
});
export type RaceMove = Static<typeof raceMove>;
export type RaceMoveKind = RaceMove["kind"];
export type RaceInput = { setup: RaceSetup; state: RaceState | null; seed: string; intent: "respond" | "continue"; withdrawn?: readonly string[]; moves: readonly RaceMove[] };
export const isRaceAutoValid = (setup: RaceSetup): boolean => setup.auto === "on" || setup.auto === "off" || setup.auto.until < setup.course.distance;
export const raceRead = Type.Object({
	conversationId: Type.Integer(), revision: Type.Integer(), status: Type.Union([Type.String(), Type.Null()]),
	state: raceState,
	castStats: Type.Array(raceCastStats),
});
export type RaceRead = Static<typeof raceRead>;
