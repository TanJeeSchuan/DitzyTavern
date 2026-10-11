import { useQuery } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Value } from "@sinclair/typebox/value";
import { raceSetup, isRaceAutoValid, type RaceSetup } from "../../shared/contract/race";
import { fillRaceField, initialRaceSetup, raceCourses } from "../../shared/race-data";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { loadRace } from "../race";
import { useSaveGuard } from "../SaveGuard";
import { RaceOval } from "./RaceOval";

// @approved
//  The revision is part of the key so completions refetch, but the previous
//  read stays mounted as placeholder data: the oval must keep its markers
//  through a refetch to animate them to the new Stretch.
const useRace = (conversation: ConversationSummary) => useQuery({
	queryKey: ["race", conversation.id, conversation.revision],
	queryFn: ({ signal }) => loadRace(conversation.id, signal),
	placeholderData: (previous) => previous,
});

export function RaceDockTab({ conversation, onRestore }: { conversation: ConversationSummary; onRestore: () => void }) {
	const read = useRace(conversation);
	return <button type="button" className="box-dock-tab" title="Restore Race" onClick={onRestore}>
		<Flag aria-hidden="true" /><span className="sr-only">Race: </span>
		<span>{read.isError ? "Unavailable" : read.data?.status ?? "Set up a race"}</span>
	</button>;
}

export function RaceWindow({ conversation, disabled, onConversationChange }: {
	conversation: ConversationSummary; disabled: boolean; onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const read = useRace(conversation);
	const current = conversation.boxSetups.race;
	const [draft, setDraft] = useState(current);
	const [saved, setSaved] = useState(current);
	const [revision, setRevision] = useState(conversation.revision);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	if (conversation.revision > revision && JSON.stringify(current) === JSON.stringify(saved)) setRevision(conversation.revision);
	const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
	const locked = disabled || pending;
	const running = draft.phase !== "setup";
	const update = (patch: Partial<RaceSetup>) => setDraft((value) => ({ ...value, ...patch }));
	const valid = Value.Check(raceSetup, draft) && isRaceAutoValid(draft);
	const save = async (setup = draft): Promise<boolean> => {
		if (locked || !valid) return false;
		setPending(true);
		setNotice(null);
		let applied = false;
		try {
			await runConversationCommand({ conversationId: conversation.id, revision: () => revision, onConversationChange, setNotice }, {
				type: "set-box-setup", box: "race", setup,
			}, {
				notices: { conflict: "The Chat changed. Review your setup and save again.", notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
				onApplied: (next) => { setDraft(next.boxSetups.race); setSaved(next.boxSetups.race); setRevision(next.revision); applied = true; },
				onConflict: (next) => { setSaved(next.boxSetups.race); setRevision(next.revision); },
			});
		} finally { setPending(false); }
		return applied;
	};
	const discard = () => { setDraft(current); setSaved(current); setRevision(conversation.revision); setNotice(null); };
	useSaveGuard({ dirty, saving: pending, save: () => save(), discard });
	const race = read.data ?? null;
	return <div className="race-window">
		<p role="status">{read.isError ? "The Race could not be read." : race?.status ?? "Choose a course and fill the field."}</p>
		{running && race !== null && <RaceOval key={race.state.raceId} course={draft.course} state={race.state} />}
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
			<Button variant="outline" onClick={() => update({ slots: fillRaceField(draft.slots, conversation.cast.map(({ name }) => name), crypto.randomUUID()) })}>Fill field</Button>
			<ol aria-label="Race field">{draft.slots.map((runner) => <li key={runner.name}>{runner.name} · {runner.style}</li>)}</ol>
		</fieldset>}
		<Field label="Auto mode"><SegmentedControl label="Auto mode" disabled={locked} value={draft.auto === "off" || draft.auto === "on" ? draft.auto : "until"}
			onValueChange={(auto) => update({ auto: auto === "until" ? { until: 400 } : auto })}
			options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }, { value: "until", label: "Until…" }]} /></Field>
		{draft.auto !== "off" && draft.auto !== "on" && <Field label="Stop with metres remaining" htmlFor="race-until">
			<Input id="race-until" disabled={locked} type="number" min={0} max={draft.course.distance - 1} value={draft.auto.until}
				onChange={(event) => update({ auto: { until: Number(event.target.value) } })} /></Field>}
		{notice !== null && <p role="alert">{notice}</p>}
		<div className="race-actions">
			{running ? <Button variant="outline" disabled={locked} onClick={() => void save({ ...initialRaceSetup, raceId: crypto.randomUUID() })}>New race</Button>
				: <Button disabled={locked || !valid || draft.slots.length < 2} onClick={() => void save({ ...draft, raceId: crypto.randomUUID(), phase: "running" })}>Start race</Button>}
			<Button variant="outline" disabled={locked || !dirty || !valid} onClick={() => void save()}>Save setup</Button>
		</div>
	</div>;
}
