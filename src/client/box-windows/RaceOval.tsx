import { useEffect, useRef, useState } from "react";
import type { Portrait as PortraitImage } from "../../shared/contract/image";
import type { RaceCourse, RaceSpectatorState } from "../../shared/contract/race";
import { imageSrc } from "../lib/image";
import { focalPosition, Portrait } from "../story/Portrait";

/** @approved
 *  A spectator's oval: the drawn course is one stylized 1600 m lap, the
 *  finish post sits at the end of the home straight, and the start line is
 *  placed as many metres back as the course distance needs. Markers sit at
 *  their Runner's actual distance, fanned into lanes so a bunched field
 *  stays legible; a field tied at one distance is staggered into a gate
 *  line. A Runner without an avatar shows its initial.
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
const ANIMATION_MS = 650;
const TURN_LENGTH = Math.PI * TURN_RADIUS;
const PERIMETER = 2 * TURN_LENGTH + 4 * STRAIGHT_HALF;
const PX_PER_METRE = PERIMETER / LAP_METRES;
const FINISH_DISTANCE = PERIMETER - FINISH_INSET;

type TrackPoint = { x: number; y: number; normalX: number; normalY: number };
type Placement = { offset: number; lane: number };
type Target = Placement & { name: string };

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

const initialFor = (name: string): string => name.trim().charAt(0).toLocaleUpperCase() || "?";

const usePlacements = (targets: readonly Target[]): ReadonlyMap<string, Placement> => {
	const [placements, setPlacements] = useState<ReadonlyMap<string, Placement>>(new Map());
	const current = useRef(placements);
	current.current = placements;
	const latest = useRef(targets);
	latest.current = targets;
	const signature = targets.map(({ name, offset, lane }) => `${name}:${offset.toFixed(2)}:${lane.toFixed(2)}`).join("|");
	useEffect(() => {
		const resolved = latest.current.map((target) => ({
			name: target.name,
			from: current.current.get(target.name),
			to: { offset: target.offset, lane: target.lane },
		}));
		const settle = () => setPlacements(new Map(resolved.map(({ name, to }) => [name, to])));
		if (resolved.every(({ from }) => from === undefined) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			settle();
			return;
		}
		const started = performance.now();
		let frame = requestAnimationFrame(function step(now) {
			const progress = Math.min(1, (now - started) / ANIMATION_MS);
			const eased = 1 - (1 - progress) ** 3;
			setPlacements(new Map(resolved.map(({ name, from, to }) => [name, from === undefined ? to : {
				offset: from.offset + (to.offset - from.offset) * eased,
				lane: from.lane + (to.lane - from.lane) * eased,
			}])));
			if (progress < 1) frame = requestAnimationFrame(step);
		});
		return () => cancelAnimationFrame(frame);
	}, [signature]);
	return placements;
};

export function RaceOval({ course, state, avatars }: { course: RaceCourse; state: RaceSpectatorState; avatars: ReadonlyMap<string, PortraitImage> }) {
	const runners = state.standings;
	const leader = runners[0];
	const startBehind = wrap(course.distance, LAP_METRES);
	const targets = runners.map((runner, index) => ({
		name: runner.name,
		offset: startBehind - runner.distance + (runner.distance === leader?.distance ? index * TIED_GATE_STAGGER : 0),
		lane: laneFor(index, runners.length),
	}));
	const placements = usePlacements(targets);
	const placed = runners.map((runner, index) => {
		const target = targets[index]!;
		const placement = placements.get(runner.name) ?? target;
		const point = pointBehind(placement.offset, course.direction);
		return { name: runner.name, avatar: avatars.get(runner.name), rank: index + 1, x: point.x + point.normalX * placement.lane, y: point.y + point.normalY * placement.lane };
	});
	const finish = pointBehind(0, course.direction);
	const start = pointBehind(startBehind, course.direction);
	const finishLine = (point: TrackPoint) => ({
		x1: point.x + point.normalX * TRACK_HALF_WIDTH, y1: point.y + point.normalY * TRACK_HALF_WIDTH,
		x2: point.x - point.normalX * TRACK_HALF_WIDTH, y2: point.y - point.normalY * TRACK_HALF_WIDTH,
	});
	const finishBand = finishLine(finish);
	const startBand = finishLine(start);
	const postTop = finish.y + TRACK_HALF_WIDTH + 2;
	const flagX = finish.x - 10;
	return <div className="race-oval">
		<svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-label={`Race course with ${runners.length} runners`}>
			<path className="race-oval-band" d={stadiumPath(TURN_RADIUS)} strokeWidth={2 * TRACK_HALF_WIDTH} />
			<path className="race-oval-rail" d={stadiumPath(TURN_RADIUS + TRACK_HALF_WIDTH)} />
			<path className="race-oval-rail" d={stadiumPath(TURN_RADIUS - TRACK_HALF_WIDTH)} />
			{startBehind > 0 && <line className="race-oval-start" x1={startBand.x1} y1={startBand.y1} x2={startBand.x2} y2={startBand.y2} />}
			<path className="race-oval-direction" d={course.direction === "left" ? "M 236 70 L 226 76 L 236 82 Z" : "M 224 70 L 234 76 L 224 82 Z"} />
			<g className="race-oval-finish">
				<line className="race-oval-finish-line" x1={finishBand.x1} y1={finishBand.y1} x2={finishBand.x2} y2={finishBand.y2} />
				<line className="race-oval-post" x1={finish.x} y1={postTop} x2={finish.x} y2={postTop + 20} />
				<rect className="race-oval-flag" x={flagX} y={postTop} width={5} height={5} />
				<rect className="race-oval-flag-alt" x={flagX + 5} y={postTop + 5} width={5} height={5} />
				<rect className="race-oval-flag-alt" x={flagX} y={postTop + 5} width={5} height={5} />
				<rect className="race-oval-flag" x={flagX + 5} y={postTop} width={5} height={5} />
				<text className="race-oval-label" x={finish.x} y={postTop + 32}>Finish</text>
			</g>
			{[...placed].reverse().map(({ name, avatar, rank, x, y }) => <g key={name} className="race-marker" data-leader={rank === 1 ? true : undefined}
				transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}>
				<rect className="race-marker-avatar" x={-8} y={-8} width={16} height={16} rx={5} />
				{avatar !== undefined
					? <foreignObject x={-7} y={-7} width={14} height={14}>
						<img className="race-marker-image" src={imageSrc(avatar.hash)} alt="" style={{ objectPosition: focalPosition(avatar) }} />
					</foreignObject>
					: <text className="race-marker-initial" y={3} textAnchor="middle">{initialFor(name)}</text>}
				<rect className="race-marker-place" x={-6} y={-19} width={12} height={10} rx={3} />
				<text className="race-marker-rank" y={-10.5} textAnchor="middle">{rank}</text>
			</g>)}
		</svg>
		<ol className="race-field" aria-label="Race order">
			{runners.map((runner, index) => <li key={runner.name} data-leader={index === 0 ? true : undefined}>
				<span className="race-field-place">{index + 1}</span>
				<Portrait name={runner.name} portrait={avatars.get(runner.name)} size="small" />
				<span className="race-field-name">{runner.name}</span>
				<span className="race-field-gap">{state.finished
					? index === 0 ? `${runner.time.toFixed(2)} s` : `+${(runner.time - (leader?.time ?? runner.time)).toFixed(2)} s`
					: index === 0 ? "Leader" : `+${(leader!.distance - runner.distance).toFixed(1)} m`}</span>
			</li>)}
		</ol>
	</div>;
}
