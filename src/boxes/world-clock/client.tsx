import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Clock } from "lucide-react";
import { Alert, AlertDescription, boxDigestKey, Button, digestWindow, Field, Input, SegmentedControl, useBoxSetupDraft, useBoxStatus } from "@/box-sdk/client";
import type { BoxClientDefinition, ConversationSummary } from "@/box-sdk/client";
import { isWorldClockStart, weatherLabels, worldClockSetup, type WorldClockRecord, type WorldClockSetup } from "./contract";
import descriptor from "./shared-descriptor";

const elapsedLabel = (minutes: number): string => {
	if (minutes === 0) return "No time passes";
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	if (hours === 0) return `+${remainder}m`;
	return remainder === 0 ? `+${hours}h` : `+${hours}h ${remainder}m`;
};

/** @approved A passage's record on the timeline, such as `+5m · ☀️ Clear`. */
const describeWorldClock = ({ minutes, weather }: WorldClockRecord): string =>
	`${elapsedLabel(minutes)}${weather === null ? "" : ` · ${weatherLabels[weather]}`}`;

/** @approved The top bar item: the in-story time, as the dock tab shows it. */
const WorldClockTopBarItem = ({ conversation }: { conversation: ConversationSummary }): ReactNode => useBoxStatus(conversation.id, "world-clock");

/** @approved The World Clock's setup form; the host's passage timeline follows it in the window. */
function WorldClockPanel({ conversation, disabled, onConversationChange }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}): ReactNode {
	const client = useQueryClient();
	const [startTouched, setStartTouched] = useState(false);
	const { draft, setDraft, dirty, pending, locked, notice, save, discard } = useBoxSetupDraft("world-clock", worldClockSetup, {
		conversation, disabled, onConversationChange,
		conflict: "The Chat changed elsewhere. Your draft was kept. Review it before saving again.",
		valid: (setup) => isWorldClockStart(setup.start),
		onSaved: () => void client.invalidateQueries({ queryKey: boxDigestKey(conversation.id, "world-clock") }),
	});
	const valid = isWorldClockStart(draft.start);
	const update = (patch: Partial<WorldClockSetup>) => setDraft((value) => ({ ...value, ...patch }));
	return <div className="world-clock-window">
		<Field label="Start" htmlFor="world-clock-start" helper={!valid && startTouched ? "Enter a real calendar date and time." : undefined}>
			<Input id="world-clock-start" type="datetime-local" value={draft.start} disabled={locked} onChange={(event) => update({ start: event.target.value })} onBlur={() => setStartTouched(true)} />
		</Field>
		<Field label="Era" htmlFor="world-clock-era">
			<Input id="world-clock-era" value={draft.era} maxLength={16} disabled={locked} onChange={(event) => update({ era: event.target.value })} />
		</Field>
		<Field label="Climate">
			<SegmentedControl label="Climate" value={draft.climate} disabled={locked} onValueChange={(climate) => update({ climate })}
				options={[{ value: "temperate", label: "Temperate" }, { value: "tropical", label: "Tropical" }, { value: "arid", label: "Arid" }, { value: "cold", label: "Cold" }]} />
		</Field>
		<Field label="Hemisphere">
			<SegmentedControl label="Hemisphere" value={draft.hemisphere} disabled={locked} onValueChange={(hemisphere) => update({ hemisphere })}
				options={[{ value: "north", label: "North" }, { value: "south", label: "South" }]} />
		</Field>
		<Field label="Temperature">
			<SegmentedControl label="Temperature unit" value={draft.unit} disabled={locked} onValueChange={(unit) => update({ unit })}
				options={[{ value: "C", label: "°C" }, { value: "F", label: "°F" }]} />
		</Field>
		{notice !== null && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
		<div className="world-clock-actions">
			{notice !== null && <Button variant="ghost" disabled={pending} onClick={discard}>Load saved setup</Button>}
			<Button disabled={locked || !dirty || !valid} onClick={() => void save()}>{pending ? "Saving…" : "Save World Clock"}</Button>
		</div>
	</div>;
}

const clockWindow = digestWindow(descriptor, { icon: Clock, size: { width: 25, height: 30 }, Panel: WorldClockPanel, describe: describeWorldClock });
export default { descriptor, icon: clockWindow.icon, Window: clockWindow, TopBarItem: WorldClockTopBarItem } satisfies BoxClientDefinition;
