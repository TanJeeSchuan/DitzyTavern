import { useQuery } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { useRef, useState } from "react";
import {
	Button, Field, imageAccept, Input, Portrait, SegmentedControl, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, uploadImage, useBoxSetupDraft,
	type BoxDataAction, type BoxDataWrite, type CastParticipant, type ConversationSummary,
} from "../../box-sdk/client";
import { Value } from "@sinclair/typebox/value";
import { raceSetup, raceStats, isRaceAutoValid, runningStyles, type RaceRunner, type RaceSetup, type RaceStats, type RunningStyle } from "./contract";
import { addRaceRunner, fillRaceField, initialRaceSetup, RACE_AVATAR_PREFIX, raceCourses, raceRandom, rollRaceStats } from "./shared-data";
import { loadRace } from "./client-read";
import { RaceOval } from "./client-oval";
import { RaceReplay } from "./client-replay";

// @approved
//  The revision is part of the key so completions refetch, but the previous
//  read stays mounted as placeholder data: the oval must keep its markers
//  through a refetch to animate them to the new Stretch.
const useRace = (conversation: ConversationSummary) => useQuery({
	queryKey: ["race", conversation.id, conversation.revision],
	queryFn: ({ signal }) => loadRace(conversation.id, signal),
	placeholderData: (previous) => previous,
});

const statKeys = ["speed", "stamina", "power", "guts", "wit"] as const;
type StatKey = typeof statKeys[number];
const statLabels = { speed: "Speed", stamina: "Stamina", power: "Power", guts: "Guts", wit: "Wit" } satisfies Record<StatKey, string>;
const isValid = (setup: RaceSetup) => Value.Check(raceSetup, setup) && isRaceAutoValid(setup);

export function RaceDockTab({ conversation, onRestore }: { conversation: ConversationSummary; onRestore: () => void }) {
	const read = useRace(conversation);
	return <button type="button" className="box-dock-tab" title="Restore Race" onClick={onRestore}>
		<Flag aria-hidden="true" /><span className="sr-only">Race: </span>
		<span>{read.isError ? "Unavailable" : read.data?.status ?? "Set up a race"}</span>
	</button>;
}

function SetAvatar({ name, onPick }: { name: string; onPick: (file: File) => void }) {
	const picker = useRef<HTMLInputElement>(null);
	return <>
		<Button variant="ghost" size="sm" onClick={() => picker.current?.click()}>Set avatar</Button>
		<input ref={picker} type="file" accept={imageAccept} hidden aria-label={`Avatar for ${name}`} onChange={(event) => {
			const file = event.target.files?.[0];
			event.target.value = "";
			if (file !== undefined) onPick(file);
		}} />
	</>;
}

export function RaceWindow({ conversation, disabled, boxData, onConversationChange }: {
	conversation: ConversationSummary; disabled: boolean; boxData: BoxDataAction; onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const read = useRace(conversation);
	// @approved
	//  The open Cast stat sheet: the Participant being slotted, the stats it
	//  starts from, and whether saving also writes the Character.
	const [sheet, setSheet] = useState<{
		participantId: number;
		name: string;
		sourceCharacterId: number | null;
		stats: RaceStats;
		saveToCharacter: boolean;
	} | null>(null);
	// @approved
	//  An open stat sheet is this window's unsaved work: the shared guard saves
	//  it by adding the Runner, and discards it with the setup draft.
	const { draft, setDraft, dirty, locked, notice, setNotice, run, command, save } = useBoxSetupDraft("race", {
		conversation, disabled, onConversationChange,
		conflict: "The Chat changed. Review your setup and save again.",
		valid: isValid,
		extra: sheet === null ? undefined : { save: () => addToField(), discard: () => setSheet(null) },
	});
	const running = draft.phase !== "setup";
	const update = (patch: Partial<RaceSetup>) => setDraft((value) => ({ ...value, ...patch }));
	const valid = isValid(draft);
	const data = read.data ?? null;
	const race = data !== null && data.state.raceId === draft.raceId ? data : null;
	const avatars = new Map(Object.entries(data?.avatars ?? {}).map(([name, { hash }]) => [name, { hash, focalX: 0.5, focalY: 0.5 }]));
	// @approved
	//  A Cast Runner's own Portrait wins over any roster avatar under the same
	//  name, focal point included.
	for (const { name, portrait } of conversation.cast) if (portrait !== undefined) avatars.set(name, portrait);
	const cast = new Set(conversation.cast.map(({ name }) => name));
	// @approved
	//  A stat sheet only opens on a read for the current revision: placeholder
	//  data would miss saved stats and roll over them.
	const statsReady = data !== null && !read.isPlaceholderData;
	const unslottedCast = conversation.cast.filter(({ id }) => !draft.slots.some(({ participantId }) => participantId === id));
	const sheetParticipant = sheet === null ? undefined : conversation.cast.find(({ id }) => id === sheet.participantId);
	const sheetValid = sheet !== null && Value.Check(raceStats, sheet.stats);
	const openSheet = (participant: CastParticipant) => {
		const stored = data?.castStats.find(({ participantId }) => participantId === participant.id)?.stats;
		setNotice(null);
		setSheet({
			participantId: participant.id,
			name: participant.name,
			sourceCharacterId: participant.sourceCharacterId,
			stats: stored ?? rollRaceStats("Pace Chaser", raceRandom(crypto.randomUUID())),
			saveToCharacter: false,
		});
	};
	const updateStat = (key: StatKey, value: number) => setSheet((current) => current === null ? null : { ...current, stats: { ...current.stats, [key]: value } });
	const rollSheet = () => setSheet((current) => current === null ? null : { ...current, stats: rollRaceStats(current.stats.style, raceRandom(crypto.randomUUID())) });
	const addToField = async (): Promise<boolean> => {
		if (sheet === null || locked || !sheetValid) return false;
		const runner: RaceRunner = { name: sheet.name, participantId: sheet.participantId, ...sheet.stats };
		const value = JSON.stringify(sheet.stats);
		// @approved
		//  The gate lands with the Participant's own stats, and the Character's
		//  when asked for, in one setup save: a refused write keeps the sheet
		//  open with its edits and commits none of them.
		const writes: BoxDataWrite[] = [{ owner: { type: "participant", participantId: sheet.participantId }, key: "stats", value }];
		if (sheet.saveToCharacter && sheet.sourceCharacterId !== null) writes.push({ owner: { type: "character", characterId: sheet.sourceCharacterId, revision: data?.characterStatsRevisions[sheet.sourceCharacterId] ?? 0 }, key: "stats", value });
		const applied = await save({ ...draft, slots: addRaceRunner(draft.slots, runner) }, writes);
		if (applied) setSheet(null);
		return applied;
	};
	const setAvatar = async (name: string, file: File) => {
		if (locked) return;
		await run(async () => {
			try {
				const { hash } = await uploadImage(file);
				const action = boxData({ type: "library", revision: data?.avatars[name]?.revision ?? 0 }, `${RACE_AVATAR_PREFIX}${name}`, hash);
				// @approved
				//  A refused write leaves the Chat revision unchanged, so the avatar
				//  revision it was refused for is read again here.
				if (!await command(action, "The Chat changed. Set the avatar again.")) void read.refetch();
			} catch (cause) {
				setNotice(cause instanceof Error ? cause.message : "That file could not be read as an image.");
			}
		});
	};
	return <div className="race-window">
		<p role="status">{read.isError ? "The Race could not be read." : race?.status ?? "Choose a course and fill the field."}</p>
		{running && race !== null && <RaceOval key={race.state.raceId} course={draft.course} state={race.state} avatars={avatars} />}
		{running && race !== null && race.replay !== null && <RaceReplay key={race.state.raceId} replay={race.replay} avatars={avatars} />}
		{!running && <fieldset disabled={locked} className="race-setup">
			<Field label="Course">
				<Select value={raceCourses.find((course) => JSON.stringify(course) === JSON.stringify(draft.course))?.name ?? "custom"}
					onValueChange={(name) => update({ course: raceCourses.find((course) => course.name === name) ?? { ...draft.course, name: "Custom course" } })}>
					<SelectTrigger aria-label="Course"><SelectValue /></SelectTrigger>
					<SelectContent>{raceCourses.map((course) => <SelectItem key={course.name} value={course.name}>{course.name}</SelectItem>)}
						<SelectItem value="custom">Custom course</SelectItem></SelectContent>
				</Select>
			</Field>
			<Field label="Course name" htmlFor="race-course-name"><Input id="race-course-name" value={draft.course.name}
				onChange={(event) => update({ course: { ...draft.course, name: event.target.value } })} /></Field>
			<Field label="Distance (m)" htmlFor="race-distance"><Input id="race-distance" type="number" min={400} max={10000} value={draft.course.distance}
				onChange={(event) => update({ course: { ...draft.course, distance: Number(event.target.value) } })} /></Field>
			<Field label="Surface"><SegmentedControl label="Surface" value={draft.course.surface}
				onValueChange={(surface) => update({ course: { ...draft.course, surface } })} options={[{ value: "turf", label: "Turf" }, { value: "dirt", label: "Dirt" }]} /></Field>
			<Field label="Direction"><SegmentedControl label="Direction" value={draft.course.direction}
				onValueChange={(direction) => update({ course: { ...draft.course, direction } })} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} /></Field>
			<Field label="Metres per Stretch" htmlFor="race-stretch"><Input id="race-stretch" type="number" min={100} max={2000} value={draft.metresPerStretch}
				onChange={(event) => update({ metresPerStretch: Number(event.target.value) })} /></Field>
			<Button variant="outline" disabled={sheet !== null} onClick={() => update({ slots: fillRaceField(draft.slots, conversation.cast.map(({ name }) => name), crypto.randomUUID()) })}>Fill field</Button>
			<Field label="Add from Cast">
				{unslottedCast.length === 0
					? <p className="race-cast-empty">Every Cast member is in the field.</p>
					: <ul className="race-cast-list">{unslottedCast.map((participant) => <li key={participant.id}>
						<Button variant="outline" size="sm" disabled={locked || !statsReady || sheet !== null} onClick={() => openSheet(participant)}>
							<Portrait name={participant.name} portrait={participant.portrait} size="small" />{participant.name}
						</Button>
					</li>)}</ul>}
			</Field>
			<ol className="race-field" aria-label="Race field">{draft.slots.map((runner) => <li key={runner.name}>
				<Portrait name={runner.name} portrait={avatars.get(runner.name)} size="small" />
				<span className="race-field-name">{runner.name} · {runner.style}</span>
				{!cast.has(runner.name) && <SetAvatar name={runner.name} onPick={(file) => void setAvatar(runner.name, file)} />}
			</li>)}</ol>
		</fieldset>}
		{sheet !== null && <section className="race-stat-sheet" aria-label={`Stats for ${sheet.name}`}>
			<header className="race-stat-sheet-header">
				<Portrait name={sheet.name} portrait={sheetParticipant?.portrait} size="small" />
				<strong>{sheet.name}</strong>
			</header>
			<Field label="Running style" htmlFor="race-stat-style">
				<Select value={sheet.stats.style} disabled={locked} onValueChange={(style) => {
					// @approved
					// SAFETY: Every Select option comes from runningStyles, so the value is one of its literals.
					const next = style as RunningStyle;
					setSheet((current) => current === null ? null : { ...current, stats: { ...current.stats, style: next } });
				}}>
					<SelectTrigger id="race-stat-style" aria-label="Running style"><SelectValue /></SelectTrigger>
					<SelectContent>{runningStyles.map((style) => <SelectItem key={style} value={style}>{style}</SelectItem>)}</SelectContent>
				</Select>
			</Field>
			<div className="race-stat-grid">
				{statKeys.map((key) => <Field key={key} label={statLabels[key]} htmlFor={`race-stat-${key}`}>
					<Input id={`race-stat-${key}`} type="number" min={1} max={1200} value={sheet.stats[key]} disabled={locked}
						onChange={(event) => updateStat(key, Number(event.target.value))} />
				</Field>)}
			</div>
			<div className="race-stat-actions">
				<Button variant="outline" disabled={locked} onClick={rollSheet}>Roll</Button>
				{sheet.sourceCharacterId !== null && <label className="race-stat-save">
					<Switch checked={sheet.saveToCharacter} disabled={locked} aria-label={`Save to ${sheetParticipant?.sourceCharacterName ?? "Character"}`}
						onCheckedChange={(saveToCharacter) => setSheet((current) => current === null ? null : { ...current, saveToCharacter })} />
					Save to {sheetParticipant?.sourceCharacterName ?? "Character"}
				</label>}
				<Button disabled={locked || !sheetValid} onClick={() => void addToField()}>Add to field</Button>
				<Button variant="ghost" disabled={locked} onClick={() => setSheet(null)}>Cancel</Button>
			</div>
		</section>}
		<Field label="Auto mode"><SegmentedControl label="Auto mode" disabled={locked} value={draft.auto === "off" || draft.auto === "on" ? draft.auto : "until"}
			onValueChange={(auto) => update({ auto: auto === "until" ? { until: 400 } : auto })}
			options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }, { value: "until", label: "Until…" }]} /></Field>
		{draft.auto !== "off" && draft.auto !== "on" && <Field label="Stop with metres remaining" htmlFor="race-until">
			<Input id="race-until" disabled={locked} type="number" min={0} max={draft.course.distance - 1} value={draft.auto.until}
				onChange={(event) => update({ auto: { until: Number(event.target.value) } })} /></Field>}
		{notice !== null && <p role="alert">{notice}</p>}
		<div className="race-actions">
			{running ? <Button variant="outline" disabled={locked} onClick={() => void save({ ...initialRaceSetup, raceId: crypto.randomUUID() })}>New race</Button>
				: <Button disabled={locked || sheet !== null || !valid || draft.slots.length < 2} onClick={() => void save({ ...draft, raceId: crypto.randomUUID(), phase: "running" })}>Start race</Button>}
			<Button variant="outline" disabled={locked || !dirty || !valid} onClick={() => void save()}>Save setup</Button>
		</div>
	</div>;
}
