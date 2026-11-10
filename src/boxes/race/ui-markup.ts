import { raceMoveCatalog, type RaceCourse, type RacePortrait, type RaceSpectatorState, type RaceView } from "./shared";

/** @approved Text and attribute values escaped for the markup the window renders. */
export const esc = (value: string | number) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const initialFor = (name: string): string => name.trim().charAt(0).toLocaleUpperCase() || "?";
/** @approved A Runner's Portrait or avatar from the frame's image path, else its initial, as the host's Portrait draws one. */
export const portrait = (image: (hash: string) => string, name: string, picture: RacePortrait | undefined) =>
	`<span class="race-portrait" aria-hidden="true">${picture === undefined ? esc(initialFor(name))
		: `<img src="${esc(image(picture.hash))}" alt="" style="object-position: ${picture.focalX * 100}% ${picture.focalY * 100}%">`}</span>`;

/** @approved
 *  A spectator's oval: the drawn course is one stylized 1600 m lap, the
 *  finish post sits at the end of the home straight, and the start line is
 *  placed as many metres back as the course distance needs. Markers sit at
 *  their Runner's actual distance, fanned into lanes so a bunched field
 *  stays legible; a field tied at one distance is staggered into a gate
 *  line. Each marker keeps its element across renders, so it glides to the
 *  next Stretch unless reduced motion is asked for.
 */
const VIEW_WIDTH = 460;
const VIEW_HEIGHT = 278;
const CENTRE_X = 230;
const CENTRE_Y = 134;
const TURN_RADIUS = 58;
const STRAIGHT_HALF = 118;
const TRACK_HALF_WIDTH = 26;
const FINISH_INSET = 38;
const LAP_METRES = 1600;
const TIED_GATE_STAGGER = 4;
const TURN_LENGTH = Math.PI * TURN_RADIUS;
const PERIMETER = 2 * TURN_LENGTH + 4 * STRAIGHT_HALF;
const PX_PER_METRE = PERIMETER / LAP_METRES;
const FINISH_DISTANCE = PERIMETER - FINISH_INSET;

type TrackPoint = { x: number; y: number; normalX: number; normalY: number };
const wrap = (value: number, span: number) => ((value % span) + span) % span;

const canonicalPoint = (distance: number): TrackPoint => {
	const at = wrap(distance, PERIMETER);
	if (at < TURN_LENGTH) {
		const angle = Math.PI / 2 - at / TURN_RADIUS;
		return { x: CENTRE_X + STRAIGHT_HALF + TURN_RADIUS * Math.cos(angle), y: CENTRE_Y + TURN_RADIUS * Math.sin(angle), normalX: Math.cos(angle), normalY: Math.sin(angle) };
	}
	if (at < TURN_LENGTH + 2 * STRAIGHT_HALF) {
		return { x: CENTRE_X + STRAIGHT_HALF - (at - TURN_LENGTH), y: CENTRE_Y - TURN_RADIUS, normalX: 0, normalY: -1 };
	}
	if (at < 2 * TURN_LENGTH + 2 * STRAIGHT_HALF) {
		const angle = -Math.PI / 2 - (at - TURN_LENGTH - 2 * STRAIGHT_HALF) / TURN_RADIUS;
		return { x: CENTRE_X - STRAIGHT_HALF + TURN_RADIUS * Math.cos(angle), y: CENTRE_Y + TURN_RADIUS * Math.sin(angle), normalX: Math.cos(angle), normalY: Math.sin(angle) };
	}
	return { x: CENTRE_X - STRAIGHT_HALF + (at - 2 * TURN_LENGTH - 2 * STRAIGHT_HALF), y: CENTRE_Y + TURN_RADIUS, normalX: 0, normalY: 1 };
};

/** @approved A point this many metres behind the finish post on the drawn course. */
const pointBehind = (metres: number, direction: RaceCourse["direction"]): TrackPoint => {
	const point = canonicalPoint(FINISH_DISTANCE - metres * PX_PER_METRE);
	return direction === "left" ? point : { x: 2 * CENTRE_X - point.x, y: point.y, normalX: -point.normalX, normalY: point.normalY };
};

const stadiumPath = (radius: number): string => [
	`M ${CENTRE_X - STRAIGHT_HALF} ${CENTRE_Y - radius}`,
	`L ${CENTRE_X + STRAIGHT_HALF} ${CENTRE_Y - radius}`,
	`A ${radius} ${radius} 0 0 1 ${CENTRE_X + STRAIGHT_HALF} ${CENTRE_Y + radius}`,
	`L ${CENTRE_X - STRAIGHT_HALF} ${CENTRE_Y + radius}`,
	`A ${radius} ${radius} 0 0 1 ${CENTRE_X - STRAIGHT_HALF} ${CENTRE_Y - radius}`,
	"Z",
].join(" ");

const laneFor = (index: number, count: number): number => {
	if (count <= 1) return 0;
	const spacing = Math.min(6, (2 * TRACK_HALF_WIDTH - 10) / (count - 1));
	return (index - (count - 1) / 2) * spacing;
};

const band = (point: TrackPoint) => `x1="${point.x + point.normalX * TRACK_HALF_WIDTH}" y1="${point.y + point.normalY * TRACK_HALF_WIDTH}" x2="${point.x - point.normalX * TRACK_HALF_WIDTH}" y2="${point.y - point.normalY * TRACK_HALF_WIDTH}"`;

type Pictures = ReadonlyMap<string, RacePortrait>;

// @approved
//  Markers are HTML over the SVG, placed in percent of the drawn course, since
// the frame's markup carries no SVG image link. They render in gate order, so
// each keeps its place in the document, and stack by rank.
export function ovalMarkup(image: (hash: string) => string, course: RaceCourse, state: RaceSpectatorState, gates: readonly string[], pictures: Pictures): string {
	const runners = state.standings;
	const leader = runners[0];
	const startBehind = wrap(course.distance, LAP_METRES);
	const placed = runners.map((runner, index) => {
		const point = pointBehind(startBehind - runner.distance + (runner.distance === leader?.distance ? index * TIED_GATE_STAGGER : 0), course.direction);
		const lane = laneFor(index, runners.length);
		return { name: runner.name, rank: index + 1, x: point.x + point.normalX * lane, y: point.y + point.normalY * lane };
	}).sort((a, b) => gates.indexOf(a.name) - gates.indexOf(b.name));
	const finish = pointBehind(0, course.direction);
	const start = pointBehind(startBehind, course.direction);
	const postTop = finish.y + TRACK_HALF_WIDTH + 2;
	const flagX = finish.x - 10;
	const svg = `<svg viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-label="Race course with ${runners.length} runners">
		<path class="race-oval-band" d="${stadiumPath(TURN_RADIUS)}" stroke-width="${2 * TRACK_HALF_WIDTH}"></path>
		<path class="race-oval-rail" d="${stadiumPath(TURN_RADIUS + TRACK_HALF_WIDTH)}"></path>
		<path class="race-oval-rail" d="${stadiumPath(TURN_RADIUS - TRACK_HALF_WIDTH)}"></path>
		${startBehind > 0 ? `<line class="race-oval-start" ${band(start)}></line>` : ""}
		<path class="race-oval-direction" d="${course.direction === "left" ? "M 236 70 L 226 76 L 236 82 Z" : "M 224 70 L 234 76 L 224 82 Z"}"></path>
		<g class="race-oval-finish">
			<line class="race-oval-finish-line" ${band(finish)}></line>
			<line class="race-oval-post" x1="${finish.x}" y1="${postTop}" x2="${finish.x}" y2="${postTop + 20}"></line>
			<rect class="race-oval-flag" x="${flagX}" y="${postTop}" width="5" height="5"></rect>
			<rect class="race-oval-flag-alt" x="${flagX + 5}" y="${postTop + 5}" width="5" height="5"></rect>
			<rect class="race-oval-flag-alt" x="${flagX}" y="${postTop + 5}" width="5" height="5"></rect>
			<rect class="race-oval-flag" x="${flagX + 5}" y="${postTop}" width="5" height="5"></rect>
			<text class="race-oval-label" x="${finish.x}" y="${postTop + 32}">Finish</text>
		</g>
	</svg>`;
	const markers = placed.map(({ name, rank, x, y }) => `<span id="race-marker-${gates.indexOf(name)}" class="race-marker"${rank === 1 ? " data-leader" : ""}
		style="left: ${(x / VIEW_WIDTH * 100).toFixed(3)}%; top: ${(y / VIEW_HEIGHT * 100).toFixed(3)}%; z-index: ${runners.length - rank + 1}">
		${portrait(image, name, pictures.get(name))}<span class="race-marker-rank">${rank}</span></span>`).join("");
	const order = runners.map((runner, index, [first = runner]) => `<li${index === 0 ? " data-leader" : ""}>
		<span class="race-field-place">${index + 1}</span>${portrait(image, runner.name, pictures.get(runner.name))}
		<span class="race-field-name">${esc(runner.name)}</span>
		<span class="race-field-gap">${state.finished
			? index === 0 ? `${runner.time.toFixed(2)} s` : `+${(runner.time - first.time).toFixed(2)} s`
			: index === 0 ? "Leader" : `+${(first.distance - runner.distance).toFixed(1)} m`}</span></li>`).join("");
	return `<div class="race-oval"><div class="race-oval-track">${svg}${markers}</div><ol class="race-field" aria-label="Race order">${order}</ol></div>`;
}

// @approved
//  The finished race, Stretch by Stretch: each Runner's place, energy left,
//  the decisions it made (marked when the writer ordered them), and any
//  Hidden intent it was carrying.
export function replayMarkup(image: (hash: string) => string, replay: NonNullable<RaceView["replay"]>, index: number, pictures: Pictures): string {
	const [stretch, final] = [replay.stretches[index], replay.stretches.at(-1)];
	if (stretch === undefined || final === undefined) return "";
	const last = final.stretch;
	const runners = stretch.runners.map((runner, place) => {
		const intent = replay.intents.find(({ runner: name, formed, payoff }) => name === runner.name && formed <= stretch.stretch && stretch.stretch <= (payoff ?? last));
		const energy = Math.round(runner.energy * 100);
		const notes = [
			...runner.decisions.map(({ kind, writer, success }) => `<span${success ? "" : " data-missed"}>${raceMoveCatalog[kind].icon} ${raceMoveCatalog[kind].label}${writer ? " (order)" : ""}${success ? "" : ", missed"}</span>`),
			...intent === undefined ? [] : [`<span data-intent>${intent.payoff === stretch.stretch ? "Charges as planned" : "Planning a late charge"}</span>`],
		].join("");
		return `<li><span class="race-field-place">${place + 1}</span>${portrait(image, runner.name, pictures.get(runner.name))}
			<span class="race-field-name">${esc(runner.name)}</span>
			<span class="race-replay-energy" title="Energy left"><span><span style="width: ${energy}%"></span></span><small>${energy}%</small></span>
			<span class="race-replay-notes">${notes}</span></li>`;
	}).join("");
	const intents = replay.intents.map(({ runner, formed, payoff }) =>
		`<li>${esc(runner)} planned a late charge in Stretch ${formed}${payoff !== null && payoff <= last ? ` and launched it in Stretch ${payoff}.` : " but never launched it."}</li>`).join("");
	return `<section class="race-replay" aria-label="Replay">
		<div class="race-replay-heading"><h3>Replay</h3><span>Stretch ${stretch.stretch} · ${replay.stretches[index - 1]?.metres ?? 0}–${stretch.metres} m</span></div>
		<input id="race-replay" type="range" aria-label="Replay Stretch" min="0" max="${replay.stretches.length - 1}" step="1" value="${index}" data-on="replay">
		<ol class="race-field race-replay-field" aria-label="Stretch ${stretch.stretch}">${runners}</ol>
		${intents === "" ? "" : `<ul class="race-replay-intents" aria-label="Hidden intents">${intents}</ul>`}
	</section>`;
}
