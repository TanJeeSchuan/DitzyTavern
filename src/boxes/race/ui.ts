import { addRaceRunner, fillRaceField, initialRaceSetup, RACE_AVATAR_PREFIX, raceCourses, raceRandom, rollRaceStats } from "./shared-data";
import {
	checkRaceMove, isRaceAutoValid, jsonEqual, raceMoveCatalog, raceStatus, runningStyles,
	type RaceMove, type RaceMoveKind, type RacePortrait, type RaceSetup, type RaceStats, type RaceView,
} from "./shared";
import { esc, ovalMarkup, portrait, replayMarkup } from "./ui-markup";

// @approved
//  The Race window, run by the host in its frame's Worker. It renders markup
// from the Race's read and turns events into staged Moves and commits.
type Frame = { moves: RaceMove[] | null; disabled: boolean; stale: boolean; snapshot: number };
type Commit = {
	snapshot: number; setup?: RaceSetup;
	writes?: { owner: { type: "library" } | { type: "character"; characterId: number } | { type: "participant"; participantId: number }; key: string; value: string }[];
	expected?: { owner: { type: "library" } | { type: "character"; characterId: number }; key: string; revision: number }[];
};
type Committed = { outcome: "applied" } | { outcome: "conflict" | "refused"; reason: string; current: { snapshot: number; view: RaceView } | null };
declare const host: {
	onRead(handler: (view: RaceView, frame: Frame) => void): void;
	onEvent(handler: (event: { type: string; name: string; data: Record<string, string>; value?: string | boolean; files?: File[] }) => void): void;
	render(html: string): void;
	stageMoves(moves: RaceMove[]): void;
	commit(commit: Commit): Promise<Committed>;
	uploadImage(file: File): Promise<{ outcome: "uploaded"; hash: string } | { outcome: "refused"; reason: string }>;
	image(hash: string): string;
	setDirty(dirty: boolean): void;
	onSave(handler: () => Promise<boolean>): void;
	onDiscard(handler: () => void): void;
};

const statKeys = ["speed", "stamina", "power", "guts", "wit"] as const;
type StatKey = typeof statKeys[number];
const statLabels = { speed: "Speed", stamina: "Stamina", power: "Power", guts: "Guts", wit: "Wit" } satisfies Record<StatKey, string>;
/** @approved SAFETY: Object.keys of the literal catalog returns exactly its keys. */
const kinds = Object.keys(raceMoveCatalog) as RaceMoveKind[];
/** @approved A fresh race id or draw seed; an opaque-origin frame is no secure context, so its Worker has no `crypto.randomUUID`. */
const seed = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const integerIn = (value: number, minimum: number, maximum: number) => Number.isInteger(value) && value >= minimum && value <= maximum;
/** @approved The checks the setup schema makes on what the form edits, so Save and Start stay off until the host would take the draft. */
const isValid = (setup: RaceSetup) => setup.course.name.length >= 1 && setup.course.name.length <= 100 && integerIn(setup.course.distance, 400, 10000)
	&& integerIn(setup.metresPerStretch, 100, 2000) && (setup.auto === "off" || setup.auto === "on" || integerIn(setup.auto.until, 0, 10000)) && isRaceAutoValid(setup);

/** @approved The open Cast stat sheet: the Participant being slotted, the stats it starts from, whether saving also writes its Character, and that Character's stats revision when the sheet opened. */
type Sheet = { participantId: number; name: string; character: { id: number; name: string | null } | null; characterRevision: number; stats: RaceStats; saveToCharacter: boolean };

let view: RaceView | undefined;
let frame: Frame = { moves: null, disabled: true, stale: false, snapshot: 0 };
/** @approved The edited setup; null follows the saved one. */
let draft: RaceSetup | null = null;
// @approved
//  The revision the unsaved work, the draft or an open stat sheet, started
// from: a later read never moves it, so a save made over another window's
// change is refused as a conflict instead of undoing it. A conflict moves
// it to the current revision, so saving again replaces that change, as the
// conflict notice says.
let base: number | null = null;
let sheet: Sheet | null = null;
let ordered: string | undefined;
let notice: string | null = null;
let busy = false;
let replayIndex = 0;
let replayRace: string | undefined;

const current = () => draft ?? view?.setup ?? initialRaceSetup;
const dirty = () => (draft !== null && view !== undefined && !jsonEqual(draft, view.setup)) || sheet !== null;
const locked = () => busy || frame.disabled;
const edit = (patch: Partial<RaceSetup>) => {
	base ??= frame.snapshot;
	draft = { ...current(), ...patch };
};
/** @approved Ends the unsaved work's hold on its revision once neither a draft nor a sheet is left. */
const settle = () => { if (draft === null && sheet === null) base = null; };
// @approved
//  The read when it shows the race `raceId` names under way or finished. A
//  stale read from before a New race or Start race names another race and
//  shows nothing, while one from the previous Stretch keeps the oval.
const currentRace = (raceId: string) => view === undefined || view.phase.kind === "setup" || view.phase.state.raceId !== raceId ? null : { ...view, phase: view.phase };

/** @approved Runs one commit with the form locked; a commit that does not land shows its reason and adopts the current read it returns. */
const commit = async (request: Commit, conflict: string): Promise<boolean> => {
	busy = true;
	notice = null;
	draw();
	try {
		const result = await host.commit(request);
		if (result.outcome === "applied") return true;
		notice = result.outcome === "conflict" ? conflict : result.reason;
		if (result.current !== null) {
			view = result.current.view;
			frame = { ...frame, snapshot: result.current.snapshot };
			if (base !== null) base = result.current.snapshot;
			if (sheet?.character) sheet = { ...sheet, characterRevision: view.characterStatsRevisions[sheet.character.id] ?? 0 };
		}
		return false;
	} finally {
		busy = false;
		draw();
	}
};
const saveSetup = async (setup = current(), writes?: Commit["writes"], expected?: Commit["expected"]) => {
	if (locked() || !isValid(setup)) return false;
	const saved = await commit({ snapshot: base ?? frame.snapshot, setup, writes, expected }, "The Chat changed. Review your setup and save again.");
	if (saved) {
		draft = null;
		settle();
	}
	draw();
	return saved;
};

// @approved
//  The gate lands with the Participant's own stats, and the Character's when
//  asked for, in one commit: a refused write keeps the sheet open with its
//  edits and commits none of them.
const addToField = async (): Promise<boolean> => {
	if (sheet === null || locked() || view === undefined || frame.stale) return false;
	const { participantId, name, stats, character, characterRevision, saveToCharacter } = sheet;
	const value = JSON.stringify(stats);
	const toCharacter = saveToCharacter && character !== null;
	const added = await saveSetup({ ...current(), slots: addRaceRunner(current().slots, { name, participantId, ...stats }) },
		[{ owner: { type: "participant", participantId }, key: "stats", value }, ...toCharacter ? [{ owner: { type: "character", characterId: character.id } as const, key: "stats", value }] : []],
		toCharacter ? [{ owner: { type: "character", characterId: character.id }, key: "stats", revision: characterRevision }] : []);
	if (added) {
		sheet = null;
		settle();
	}
	draw();
	return added;
};

const setAvatar = async (name: string, file: File) => {
	if (locked() || view === undefined) return;
	busy = true;
	draw();
	const uploaded = await host.uploadImage(file);
	busy = false;
	if (uploaded.outcome === "refused") {
		notice = uploaded.reason;
		draw();
		return;
	}
	const key = `${RACE_AVATAR_PREFIX}${name}`;
	await commit({ snapshot: frame.snapshot, writes: [{ owner: { type: "library" }, key, value: uploaded.hash }], expected: [{ owner: { type: "library" }, key, revision: view.avatars[name]?.revision ?? 0 }] }, "The Chat changed. Set the avatar again.");
};

const openSheet = (participantId: number) => {
	const member = view?.cast.find(({ id }) => id === participantId);
	if (member === undefined || view === undefined) return;
	notice = null;
	const stored = view.castStats.find((entry) => entry.participantId === participantId)?.stats;
	base ??= frame.snapshot;
	sheet = { participantId, name: member.name, character: member.character, characterRevision: member.character === null ? 0 : view.characterStatsRevisions[member.character.id] ?? 0, stats: stored ?? rollRaceStats("Pace Chaser", raceRandom(seed())), saveToCharacter: false };
};

const disabledIf = (condition: boolean) => condition ? " disabled" : "";
const checkedIf = (condition: boolean) => condition ? " checked" : "";
const radios = (name: string, label: string, value: string, options: readonly (readonly [string, string])[], off: boolean) =>
	`<div class="race-segmented" role="radiogroup" aria-label="${label}">${options.map(([option, text]) =>
		`<label><input type="radio" name="race-${name}" value="${option}" data-on="${name}"${checkedIf(option === value)}${disabledIf(off)}><span>${text}</span></label>`).join("")}</div>`;
const field = (label: string, control: string, id?: string) => `<div class="race-field-control">${id === undefined ? `<span class="race-label">${label}</span>` : `<label class="race-label" for="${id}">${label}</label>`}${control}</div>`;

function setupMarkup(setup: RaceSetup, pictures: ReadonlyMap<string, RacePortrait>): string {
	const off = locked();
	const castNames = new Set(view?.cast.map(({ name }) => name));
	const unslotted = view?.cast.filter(({ id }) => !setup.slots.some(({ participantId }) => participantId === id)) ?? [];
	const statsReady = view !== undefined && !frame.stale;
	const preset = raceCourses.find((course) => jsonEqual(course, setup.course))?.name ?? "custom";
	return `<fieldset class="race-setup"${disabledIf(off)}>
		${field("Course", `<select id="race-course" aria-label="Course" data-on="course">${[...raceCourses.map(({ name }) => name), "custom"].map((name) =>
			`<option value="${esc(name)}"${name === preset ? " selected" : ""}>${name === "custom" ? "Custom course" : esc(name)}</option>`).join("")}</select>`)}
		${field("Course name", `<input id="race-course-name" value="${esc(setup.course.name)}" data-on="course-name">`, "race-course-name")}
		${field("Distance (m)", `<input id="race-distance" type="number" min="400" max="10000" value="${esc(setup.course.distance)}" data-on="distance">`, "race-distance")}
		${field("Surface", radios("surface", "Surface", setup.course.surface, [["turf", "Turf"], ["dirt", "Dirt"]], off))}
		${field("Direction", radios("direction", "Direction", setup.course.direction, [["left", "Left"], ["right", "Right"]], off))}
		${field("Metres per Stretch", `<input id="race-stretch" type="number" min="100" max="2000" value="${esc(setup.metresPerStretch)}" data-on="stretch">`, "race-stretch")}
		<button type="button" class="race-outline" data-on="fill"${disabledIf(sheet !== null)}>Fill field</button>
		${field("Add from Cast", unslotted.length === 0 ? `<p class="race-muted">Every Cast member is in the field.</p>`
			: `<ul class="race-cast-list">${unslotted.map((member) => `<li><button type="button" class="race-outline race-small" data-on="cast" data-id="${member.id}"${disabledIf(off || !statsReady || sheet !== null)}>
				${portrait(host.image, member.name, member.portrait ?? undefined)}${esc(member.name)}</button></li>`).join("")}</ul>`)}
		<ol class="race-field" aria-label="Race field">${setup.slots.map((runner) => `<li>${portrait(host.image, runner.name, pictures.get(runner.name))}
			<span class="race-field-name">${esc(runner.name)} · ${esc(runner.style)}</span>
			${castNames.has(runner.name) ? "" : `<label class="race-ghost race-small">Set avatar<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden aria-label="Avatar for ${esc(runner.name)}" data-on="avatar" data-name="${esc(runner.name)}"${disabledIf(off)}></label>`}
		</li>`).join("")}</ol>
	</fieldset>`;
}

function sheetMarkup(open: Sheet): string {
	const off = locked();
	const member = view?.cast.find(({ id }) => id === open.participantId);
	const characterName = open.character?.name ?? "Character";
	return `<section class="race-stat-sheet" aria-label="Stats for ${esc(open.name)}">
		<header class="race-stat-sheet-header">${portrait(host.image, open.name, member?.portrait ?? undefined)}<strong>${esc(open.name)}</strong></header>
		${field("Running style", `<select id="race-stat-style" aria-label="Running style" data-on="style"${disabledIf(off)}>${runningStyles.map((style) =>
			`<option${style === open.stats.style ? " selected" : ""}>${style}</option>`).join("")}</select>`, "race-stat-style")}
		<div class="race-stat-grid">${statKeys.map((key) => field(statLabels[key],
			`<input id="race-stat-${key}" type="number" min="1" max="1200" value="${open.stats[key]}" data-on="stat" data-key="${key}"${disabledIf(off)}>`, `race-stat-${key}`)).join("")}</div>
		<div class="race-stat-actions">
			<button type="button" class="race-outline" data-on="roll"${disabledIf(off)}>Roll</button>
			${open.character === null ? "" : `<label class="race-stat-save"><input type="checkbox" role="switch" aria-label="Save to ${esc(characterName)}" data-on="save-character"${checkedIf(open.saveToCharacter)}${disabledIf(off)}>Save to ${esc(characterName)}</label>`}
			<button type="button" data-on="add"${disabledIf(off || frame.stale || !statKeys.every((key) => integerIn(open.stats[key], 1, 1200)))}>Add to field</button>
			<button type="button" class="race-ghost" data-on="cancel"${disabledIf(off)}>Cancel</button>
		</div>
	</section>`;
}

// @approved
//  Offers only the Moves legal after the ones already staged, each with its
//  projected energy cost and odds. The human-seat Runner is the gate whose
//  Participant is the human-controlled one; otherwise Moves are orders to
//  the Runner the writer picks. While a read of a new revision loads, the
//  offers come from the previous state, so none of them stages a Move.
function movesMarkup(): string {
	if (view === undefined) return "";
	const { setup } = view;
	const seat = view.human === null ? undefined : setup.slots.find(({ participantId }) => participantId === view?.human)?.name;
	const runner = seat ?? (setup.slots.some(({ name }) => name === ordered) ? ordered : setup.slots[0]?.name);
	const race = currentRace(setup.raceId);
	if (race === null || race.phase.kind === "finished" || runner === undefined) return "";
	const staged = frame.moves ?? [];
	const offers = kinds.map((kind) => ({ kind, check: checkRaceMove(setup, race.phase, staged, { kind, runner }) }));
	const open = checkRaceMove(setup, race.phase, [], { kind: "hold", runner });
	const off = frame.disabled || frame.moves === null || frame.stale;
	return `<section class="race-moves" aria-label="Race Moves">
		${seat !== undefined ? `<p>Moves for ${esc(seat)}</p>` : field("Order Runner", `<select id="race-order" aria-label="Order Runner" data-on="order"${disabledIf(frame.disabled)}>${setup.slots.map(({ name }) =>
			`<option${name === runner ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>`)}
		<div class="race-moves-offer">${offers.map(({ kind, check }) => !check.legal ? "" : `<button type="button" class="race-outline race-small" data-on="move" data-kind="${kind}" data-runner="${esc(runner)}"${disabledIf(off)}>
			${raceMoveCatalog[kind].icon} ${raceMoveCatalog[kind].label}<small>${check.cost === 0 ? "" : `${check.cost > 0 ? "−" : "+"}${Math.round(Math.abs(check.cost) * 100)}% energy · `}${Math.round(check.odds * 100)}%</small></button>`).join("")}</div>
		${!open.legal ? `<p>${esc(open.reason)}</p>` : offers.every(({ check }) => !check.legal) ? "<p>No more Moves this Stretch.</p>" : ""}
	</section>`;
}

function draw() {
	host.setDirty(dirty());
	const setup = current();
	const running = setup.phase !== "setup";
	const race = currentRace(setup.raceId);
	/** @approved A Cast Runner's own Portrait wins over any roster avatar under the same name, focal point included. */
	const pictures = new Map<string, RacePortrait>(Object.entries(view?.avatars ?? {}).map(([name, { hash }]) => [name, { hash, focalX: 0.5, focalY: 0.5 }]));
	for (const { name, portrait: picture } of view?.cast ?? []) if (picture !== null) pictures.set(name, picture);
	const raceId = race?.phase.state.raceId;
	if (raceId !== replayRace) [replayRace, replayIndex] = [raceId, 0];
	const off = locked();
	const auto = setup.auto === "off" || setup.auto === "on" ? setup.auto : "until";
	const status = race === null ? null : raceStatus(view?.setup ?? setup, race.phase, view?.setup.slots.find(({ participantId }) => participantId !== undefined && participantId === view?.human)?.name);
	const valid = isValid(setup);
	host.render(`<div class="race-window">
		<p role="status">${esc(view === undefined ? "Reading the race…" : status ?? "Choose a course and fill the field.")}</p>
		${running && race !== null ? ovalMarkup(host.image, setup.course, race.phase.state, setup.slots.map(({ name }) => name), pictures) : ""}
		${running && race !== null && race.replay !== null ? replayMarkup(host.image, race.replay, replayIndex, pictures) : ""}
		${running ? "" : setupMarkup(setup, pictures)}
		${sheet === null ? "" : sheetMarkup(sheet)}
		${field("Auto mode", radios("auto", "Auto mode", auto, [["off", "Off"], ["on", "On"], ["until", "Until…"]], off))}
		${setup.auto === "off" || setup.auto === "on" ? "" : field("Stop with metres remaining",
			`<input id="race-until" type="number" min="0" max="${setup.course.distance - 1}" value="${esc(setup.auto.until)}" data-on="until"${disabledIf(off)}>`, "race-until")}
		${notice === null ? "" : `<p role="alert">${esc(notice)}</p>`}
		<div class="race-actions">
			${running ? `<button type="button" class="race-outline" data-on="new-race"${disabledIf(off)}>New race</button>`
				: `<button type="button" data-on="start"${disabledIf(off || sheet !== null || !valid || setup.slots.length < 2)}>Start race</button>`}
			<button type="button" class="race-outline" data-on="save"${disabledIf(off || draft === null || !dirty() || !valid)}>Save setup</button>
		</div>
		${movesMarkup()}
	</div>`);
}

const numberOf = (value: string | boolean | undefined) => Number(value);
host.onRead((read, next) => {
	view = read;
	frame = next;
	if (draft !== null && jsonEqual(draft, read.setup)) draft = null;
	settle();
	draw();
});
host.onEvent(({ type, name, data, value, files }) => {
	const setup = current();
	const text = value === undefined || value === true || value === false ? "" : value;
	const kind = kinds.find((candidate) => candidate === data.kind);
	const style = runningStyles.find((candidate) => candidate === text);
	const stat = statKeys.find((key) => key === data.key);
	if (type === "click") {
		if (name === "fill") edit({ slots: fillRaceField(setup.slots, view?.cast.map(({ name: castName }) => castName) ?? [], seed()) });
		if (name === "cast") openSheet(Number(data.id));
		if (name === "roll" && sheet !== null) sheet = { ...sheet, stats: rollRaceStats(sheet.stats.style, raceRandom(seed())) };
		if (name === "add") void addToField();
		if (name === "cancel") {
			sheet = null;
			settle();
		}
		if (name === "new-race") void saveSetup({ ...initialRaceSetup, raceId: seed() });
		if (name === "start" && sheet === null && setup.slots.length >= 2) void saveSetup({ ...setup, raceId: seed(), phase: "running" });
		if (name === "save") void saveSetup();
		if (name === "move" && kind !== undefined && frame.moves !== null && !frame.stale) host.stageMoves([...frame.moves, { kind, runner: data.runner ?? "" }]);
	}
	if (type === "change" || type === "input") {
		if (name === "course" && type === "change") edit({ course: raceCourses.find((course) => course.name === text) ?? { ...setup.course, name: "Custom course" } });
		if (name === "course-name") edit({ course: { ...setup.course, name: text } });
		if (name === "distance") edit({ course: { ...setup.course, distance: numberOf(value) } });
		if (name === "stretch") edit({ metresPerStretch: numberOf(value) });
		if (name === "surface" && (text === "turf" || text === "dirt")) edit({ course: { ...setup.course, surface: text } });
		if (name === "direction" && (text === "left" || text === "right")) edit({ course: { ...setup.course, direction: text } });
		if (name === "auto" && type === "change") edit({ auto: text === "until" ? { until: 400 } : text === "off" ? "off" : "on" });
		if (name === "until") edit({ auto: { until: numberOf(value) } });
		if (name === "order") ordered = text;
		if (name === "replay") replayIndex = numberOf(value);
		if (name === "style" && style !== undefined && sheet !== null) sheet = { ...sheet, stats: { ...sheet.stats, style } };
		if (name === "stat" && stat !== undefined && sheet !== null) sheet = { ...sheet, stats: { ...sheet.stats, [stat]: numberOf(value) } };
		if (name === "save-character" && sheet !== null) sheet = { ...sheet, saveToCharacter: value === true };
		const [file] = files ?? [];
		if (name === "avatar" && file !== undefined && data.name !== undefined) void setAvatar(data.name, file);
	}
	draw();
});
// @approved
//  An open stat sheet is this window's unsaved work beside the setup draft:
// the window's save guard saves it by adding the Runner, and discards it
// with the draft.
host.onSave(async () => sheet !== null ? await addToField() : await saveSetup());
host.onDiscard(() => {
	draft = null;
	sheet = null;
	settle();
	notice = null;
	draw();
});
draw();
