import { expect, test } from "bun:test";
import { initialRaceSetup } from "./shared-data";
import type { RaceView } from "./shared";

type Commit = { snapshot: number; setup?: typeof initialRaceSetup; expected?: { revision: number }[] };
type Event = { type: string; name: string; data: Record<string, string>; value?: string | boolean };
type Frame = { moves: null; disabled: boolean; stale: boolean; snapshot: number };

// @approved
//  The window runs against a host that records each commit and answers it as
// the test says, so a test drives it as the frame would: reads, then events.
const commits: Commit[] = [];
type Committed = { outcome: "applied" } | { outcome: "conflict"; reason: string; current: { snapshot: number; view: RaceView } };
const answers: (() => Committed)[] = [];
let onRead: (view: RaceView, frame: Frame) => void = () => undefined;
let onEvent: (event: Event) => void = () => undefined;
Object.assign(globalThis, {
	host: {
		onRead: (handler: typeof onRead) => { onRead = handler; },
		onEvent: (handler: typeof onEvent) => { onEvent = handler; },
		render: () => undefined, stageMoves: () => undefined, image: (hash: string) => hash, setDirty: () => undefined, onSave: () => undefined, onDiscard: () => undefined,
		uploadImage: () => Promise.reject(new Error("No upload in this test.")),
		commit: async (commit: Commit) => { commits.push(commit); return answers.shift()?.() ?? { outcome: "applied" }; },
	},
});
await import("./ui");

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const view = (surface: "turf" | "dirt", characterRevision: number): RaceView => ({
	setup: { ...initialRaceSetup, course: { ...initialRaceSetup.course, surface } }, phase: { kind: "setup" }, replay: null, human: null, avatars: {}, castStats: [],
	cast: [{ id: 7, name: "Maren Voss", portrait: null, character: { id: 3, name: "Maren Voss" } }], characterStatsRevisions: { 3: characterRevision },
});
const read = (snapshot: number, surface: "turf" | "dirt", characterRevision = 1) => onRead(view(surface, characterRevision), { moves: null, disabled: false, stale: false, snapshot });
const click = (name: string, data: Record<string, string> = {}) => onEvent({ type: "click", name, data });

// @approved
//  A draft started at revision 10 is still the draft of revision 10 once
// another window's change arrives at 11: its save names 10, so the host
// refuses it as a conflict instead of undoing that change. Saving again
// after the conflict names the revision the conflict showed.
test("a setup draft saves against the revision it started from, and against the conflict's revision once refused", async () => {
	commits.length = 0;
	read(10, "turf");
	onEvent({ type: "input", name: "distance", data: {}, value: "1600" });
	read(11, "dirt");
	answers.push(() => ({ outcome: "conflict", reason: "", current: { snapshot: 11, view: view("dirt", 1) } }));
	click("save");
	await settled();
	click("save");
	await settled();
	expect(commits.map(({ snapshot, setup }) => [snapshot, setup?.course.surface, setup?.course.distance])).toEqual([[10, "turf", 1600], [11, "turf", 1600]]);
});

// @approved
//  A stat sheet saving to its Character names the Character's revision from
// when the sheet opened, not one a later read brought, and the commit's
// snapshot is the revision the sheet opened at.
test("a stat sheet's save names the revisions from when it opened", async () => {
	commits.length = 0;
	click("cancel");
	read(20, "turf", 1);
	click("cast", { id: "7" });
	onEvent({ type: "change", name: "save-character", data: {}, value: true });
	read(21, "turf", 2);
	click("add");
	await settled();
	expect(commits.map(({ snapshot, expected }) => [snapshot, expected?.map(({ revision }) => revision)])).toEqual([[20, [1]]]);
});
